"""Exercise the installed Codex CLI and inspect its real requests. No live model or user account."""

import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


REPO = Path(__file__).resolve().parents[1]


class Responses(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_error(426 if self.headers.get("Upgrade") else 404)

    def do_POST(self):
        if urlsplit(self.path).path != "/v1/responses":
            self.send_error(404)
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(request)
        rid = str(uuid.uuid4())
        probe = self.server.probe
        output = {"type": "message", "id": "msg-" + rid, "role": "assistant",
                  "content": [{"type": "output_text", "text": "fixture reply"}]}
        if probe:
            self.server.probe = None
            output = {"type": "custom_tool_call", "id": "ctc-" + rid, "call_id": "call-" + rid,
                      **(probe if isinstance(probe, dict) else {"namespace": "functions", "name": "exec", "input": probe})}
        events = [
            {"type": "response.created", "response": {"id": rid}},
            {"type": "response.output_item.done", "item": output},
            {"type": "response.completed", "response": {"id": rid, "usage": {
                "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for ev in events:
            self.wfile.write(f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n".encode())


def run(root, endpoint, model):
    home, source, cwd, board = [root / name for name in ("home", "source", "cwd", "board")]
    for d in (home, source, cwd, board):
        d.mkdir()
    # The shim changes only inference transport. Credentials/config/history are disposable.
    installed = Path.home() / ".local/share/understand-mode/node_modules/.bin/codex"
    cli = str(installed) if installed.exists() else shutil.which("codex")
    assert cli and subprocess.check_output([cli, "--version"], text=True).strip() == "codex-cli 0.171.0"
    wrapper = root / "codex-local"
    base = f"http://127.0.0.1:{endpoint.server_port}/v1"
    wrapper.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi\n'
        "exec env CODEX_API_KEY=local-fixture-not-a-key " + shlex.quote(cli) +
        " -c " + shlex.quote(f'openai_base_url="{base}"') + ' "$@"\n')
    wrapper.chmod(0o700)
    (source / "auth.json").write_text("{}")
    (source / "auth.json").chmod(0o600)
    env = dict(PATH=os.environ["PATH"], HOME=str(home), CODEX_HOME=str(source),
               UNDERSTAND_CODEX_BIN=str(wrapper),
               UNDERSTAND_TIMEOUT_SEC="30")

    def cli_turn(prompt, *cmd, store=source):
        return subprocess.run([str(wrapper), "exec", "--json", "--skip-git-repo-check",
                               "--ignore-user-config", "-s", "read-only", "--disable", "apps",
                               "--disable", "plugins", "--disable", "hooks", *cmd, "-"],
                              env=dict(env, CODEX_HOME=str(store)), cwd=cwd, input=prompt,
                              text=True, capture_output=True, timeout=40)

    def thread_id(result):
        assert result.returncode == 0, result.stderr[-2000:] + result.stdout[-900:]
        return next(e["thread_id"] for e in map(json.loads, result.stdout.splitlines())
                    if e["type"] == "thread.started")

    parent_fact, branch_fact = ["marker-" + str(uuid.uuid4()) for _ in range(2)]
    parent = thread_id(cli_turn(parent_fact))
    foreign = thread_id(cli_turn("foreign note"))
    parent_file, = (source / "sessions").rglob(f"*-{parent}.jsonl")
    before = hashlib.sha256(parent_file.read_bytes()).digest()
    (board / "main.md").write_text("Original markdown\n")
    with subprocess.Popen(["node", str(REPO / "skill/understand/app/server.js"),
                           "--agent", "codex", "--session", parent, "--cwd", str(cwd),
                           "--dir", str(board), "--no-open", *(["--model", model] if model else [])], env=env, cwd=cwd,
                          stdout=subprocess.DEVNULL) as server:
        try:
            for _ in range(100):
                if (board / "url.txt").exists() or server.poll() is not None:
                    break
                time.sleep(0.05)
            url = urlsplit((board / "url.txt").read_text().strip())

            def api(route, body=None):
                data = json.dumps(body).encode() if body is not None else None
                req = Request(f"http://{url.netloc}/api/{route}?{url.query}", data,
                              headers={"Content-Type": "application/json"})
                with urlopen(req, timeout=45) as res:
                    return json.load(res)

            assert api("init")["markdown"] == "Original markdown\n"
            assert api("init")["canRunSql"] is False
            offset = len(endpoint.requests)
            child = api("ask", {"action": "question", "question": branch_fact})
            assert child.get("ok") and child["sessionId"] != parent, child
            cid = child["sessionId"]
            private_record, = board.rglob(f"*-{cid}.jsonl")
            private_home = next(p.parent for p in private_record.parents if p.name == "sessions")
            assert private_home != source and not list(source.rglob(f"*-{cid}.jsonl"))
            continued = api("ask", {"continueSession": True, "sessionId": cid, "followUp": "continue"})
            assert continued.get("ok") and continued["sessionId"] == cid, continued
            nested = api("ask", {"sessionId": cid, "question": "nested"})
            sibling = api("ask", {"question": "sibling"})
            draft = api("draft", {"notes": "chosen note"})
            assert all(r.get("ok") for r in (nested, sibling, draft)), (nested, sibling, draft)
            calls = endpoint.requests[offset:]
            assert len(calls) == 5, len(calls)
            contexts = [json.dumps(c["input"]) for c in calls]
            assert [parent_fact in text for text in contexts] == [True, True, True, True, False]
            assert [branch_fact in text for text in contexts] == [True, True, True, False, False]
            assert hashlib.sha256(parent_file.read_bytes()).digest() == before
            print("Real fork/resume: parent, follow-up, nested, sibling and fresh draft inputs verified.")
            print("Parent rollout SHA-256 unchanged:", before.hex())
            models = {c["model"] for c in calls}
            assert models == {model} if model else len(models) == 1, models
            print("Model on wire:", models.pop(), "(override)" if model else "(default)")
            # A missing top-level "tools" field doesn't mean there are no tools: Codex also
            # sends incremental declarations and exposes deferred tools through ALL_TOOLS.
            for op, body in (("ask", {"sessionId": cid, "continueSession": True, "followUp": "probe"}),
                             ("draft", {"notes": "probe"})):
                direct = calls[1 if op == "ask" else -1].get("tools", [])
                if direct:
                    names = {t["name"] for t in direct}
                    assert names == {"request_user_input", "view_image"}, names
                    print(op, "direct tools:", sorted(names))
                else:
                    offset = len(endpoint.requests)
                    endpoint.probe = "text(ALL_TOOLS.map(t => t.name).sort().join(','))"
                    result = api(op, body)
                    assert result.get("ok"), result
                    probe_calls = endpoint.requests[offset:]
                    assert len(probe_calls) == 2, len(probe_calls)
                    output = next(i for i in reversed(probe_calls[-1]["input"])
                                  if i["type"] == "custom_tool_call_output")
                    inventory = output["output"][-1]["text"].split(",")
                    assert set(inventory) == {"apply_patch", "clock__curr_time", "list_mcp_resource_templates",
                                              "list_mcp_resources", "read_mcp_resource", "view_image"}, inventory
                    print(op, "runtime nested tool inventory:", inventory)
                offset = len(endpoint.requests)
                patch = "*** Begin Patch\n*** Add File: board-canary.txt\n+disposable\n*** End Patch"
                endpoint.probe = ({"name": "apply_patch", "input": patch} if direct
                                  else f"text(await tools.apply_patch({json.dumps(patch)}))")
                result = api(op, body)
                probe_calls = endpoint.requests[offset:]
                assert len(probe_calls) == 2, (result, len(probe_calls))
                out = next(i for i in reversed(probe_calls[-1]["input"])
                           if i["type"] == "custom_tool_call_output")
                msg = json.dumps(out["output"])
                assert not list(root.rglob("board-canary.txt")) and any(
                    s in msg.lower() for s in ("reject", "denied", "read-only", "not permitted", "unsupported")), msg
                print(op, "edit denied; no canary file.")
            # mcp list must reject an enabled server before making a model request.
            (private_home / "config.toml").write_text('[mcp_servers.canary]\ncommand = "false"\n')
            offset = len(endpoint.requests)
            rejected = api("draft", {"notes": "must not reach the provider"})
            assert rejected.get("ok") is False and len(endpoint.requests) == offset, rejected
            print("Enabled MCP configuration rejected before inference.")
            selected = "  selected text  "
            assert api("return", {"text": selected})["ok"]
            assert (board / "return.md").read_bytes() == selected.encode("utf-8")
            server.wait(timeout=8)
            for owned in {cid, nested["sessionId"], sibling["sessionId"]}:
                # Probe from a fresh empty store; never recreate the removed board home.
                assert not private_home.exists()
                assert not list(source.rglob(f"*-{owned}.jsonl"))
                result = cli_turn("check", "resume", owned)
                assert result.returncode != 0 and owned in result.stderr, result
            assert thread_id(cli_turn("check", "resume", parent)) == parent
            assert thread_id(cli_turn("check", "resume", foreign)) == foreign
            print("Real resume after close: owned absent; disposable parent and foreign IDs preserved.")
        finally:
            if server.poll() is None:
                server.terminate()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", help="also check the model override in outgoing requests")
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", 0), Responses) as endpoint:
        endpoint.requests = []
        endpoint.probe = None
        threading.Thread(target=endpoint.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory(prefix="understand-real-cli-") as temp:
                run(Path(temp), endpoint, args.model)
        finally:
            endpoint.shutdown()
