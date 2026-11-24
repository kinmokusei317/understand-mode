'use strict';

const loginPicker = (() => {
  const inherit = '本筋の会話を引き継ぐ';
  const label = ({ provider, model }) => `${provider === 'codex' ? 'Codex' : 'Claude'} / ${model}`;
  let catalog;

  function providers() {
    if (!catalog) {
      catalog = fetch('/api/providers', { headers: apiHeaders }).then(async (res) => {
        const data = await res.json();
        if (!res.ok || !data.ok || !Array.isArray(data.providers)) throw new Error();
        return data.providers;
      }).finally(() => { catalog = null; });
    }
    return catalog;
  }

  function render(st) {
    const box = el('div', 'login-picker');
    const details = el('details');
    const summary = el('summary');
    const select = el('select');
    select.setAttribute('aria-label', '質問の送信先とモデル');
    const status = el('div');
    status.setAttribute('role', 'status');
    const note = el('div', 'login-picker-note');
    const update = () => {
      summary.textContent = '送信先：' + (st.loginChoice ? `${label(st.loginChoice)}（履歴なし）` : inherit);
      note.hidden = !st.loginChoice;
      note.textContent = st.loginChoice ? `送信すると、選んだ引用と今回の質問だけを ${label(st.loginChoice)} に渡します。過去の会話は送りません。` : '';
    };
    details.ontoggle = async () => {
      if (!details.open) return;
      select.replaceChildren(new Option(inherit, ''));
      select.disabled = true;
      status.textContent = 'ログイン中のCLIを確認しています…';
      try {
        const list = await providers();
        select.replaceChildren(new Option(inherit, ''));
        for (const { id, models } of list) {
          for (const model of models) {
            const choice = { provider: id, model };
            select.add(new Option(`${label(choice)}（履歴なし）`, JSON.stringify(choice)));
          }
        }
        status.textContent = select.length === 1 ? 'ログイン中のCLIがありません。' : '';
      } catch {
        status.textContent = 'CLIを確認できませんでした。閉じて開き直すと再確認できます。';
      }
      if (st.loginChoice) {
        const value = JSON.stringify(st.loginChoice);
        if (![...select.options].some((o) => o.value === value)) {
          const unavailable = new Option(`${label(st.loginChoice)}（利用できません）`, value);
          unavailable.disabled = true;
          select.add(unavailable);
        }
        select.value = value;
      }
      select.disabled = !!st.busy;
    };
    select.onchange = () => {
      st.loginChoice = select.value ? JSON.parse(select.value) : null;
      update();
      save();
    };
    update();
    details.append(summary, select, status);
    box.append(details, note);
    return box;
  }
  return { render, label };
})();
