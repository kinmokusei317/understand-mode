'use strict';

const localFigures = (() => {
  const pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(?:png|jpe?g|webp)$/;
  const endpoint = '/api/figures';
  let headers;

  class BoardFigure extends HTMLElement {
    async connectedCallback() {
      const name = this.dataset.name;
      if (!headers || !pattern.test(name || '')) return;
      const caption = this.dataset.caption || name;
      const controller = new AbortController();
      this.controller = controller;
      try {
        const r = await fetch(`${endpoint}/${name}`, { headers, signal: controller.signal, redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error();
        const blob = await r.blob();
        if (controller.signal.aborted) return;
        const image = document.createElement('img');
        image.alt = caption;
        this.url = URL.createObjectURL(blob);
        image.src = this.url;
        this.replaceChildren(image);
      } catch {
        if (!controller.signal.aborted) this.textContent = `図を表示できません：${caption}`;
      }
    }
    disconnectedCallback() {
      this.controller?.abort();
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  function markdown(text) {
    const inert = document.createElement('template');
    inert.innerHTML = marked.parse(text || '');
    for (const img of inert.content.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      const caption = img.getAttribute('alt') || '画像';
      if (src.startsWith('images/') && pattern.test(src.slice(7))) {
        const figure = document.createElement('board-figure');
        figure.dataset.name = src.slice(7);
        figure.dataset.caption = caption;
        img.replaceWith(figure);
      } else {
        img.replaceWith(document.createTextNode(`［表示しない画像：${caption}］`));
      }
    }
    for (const input of inert.content.querySelectorAll('input')) {
      if (input.type !== 'checkbox' || !input.disabled) input.remove();
    }
    return DOMPurify.sanitize(inert.content, {
      ALLOWED_TAGS: 'a b blockquote br code del details div em h1 h2 h3 h4 h5 h6 hr i input kbd li mark ol p pre s span strong sub summary sup table tbody td th thead tr ul board-figure'.split(' '),
      ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align', 'type', 'disabled', 'checked', 'data-file', 'data-start', 'data-name', 'data-caption'],
      ALLOW_DATA_ATTR: false,
      CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^board-figure$/, attributeNameCheck: /^(data-name|data-caption)$/ },
    });
  }

  function init(token) {
    headers = { 'X-Understand-Token': token };
    customElements.define('board-figure', BoardFigure);
    const gallery = document.querySelector('#figure-gallery');
    const list = gallery.querySelector('.figure-list');
    const status = gallery.querySelector('[role=status]');
    const picker = gallery.querySelector('input');
    let generation = 0;
    async function refresh() {
      const current = ++generation;
      try {
        const r = await fetch(endpoint, { headers, redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error();
        const { names } = await r.json();
        if (current !== generation) return;
        list.replaceChildren();
        for (const name of names) {
          if (!pattern.test(name)) continue;
          const card = document.createElement('figure');
          const image = document.createElement('board-figure');
          image.dataset.name = name;
          const label = document.createElement('figcaption');
          label.textContent = `images/${name}`;
          card.append(image, label);
          list.append(card);
        }
        status.textContent = names.length ? `${names.length} 件の図` : 'このノートにはまだ図がありません。';
      } catch {
        if (current === generation) status.textContent = '図の一覧を読み込めません。';
      }
    }
    gallery.ontoggle = () => {
      if (gallery.open) refresh();
      else { generation++; list.replaceChildren(); }
    };
    gallery.closest('dialog').addEventListener('close', () => { gallery.open = false; });
    gallery.querySelector('button').onclick = refresh;
    picker.onchange = async () => {
      const file = picker.files[0];
      if (!file) return;
      picker.disabled = true;
      try {
        if (file.size > 4 * 1024 * 1024) throw new Error('図は4 MiBまでです');
        const r = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': file.type },
          body: file, redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error((await r.json()).error);
        if (gallery.open) await refresh();
      } catch (e) {
        status.textContent = `追加できません：${e.message}`;
      } finally { picker.disabled = false; picker.value = ''; }
    };
  }
  return { init, markdown };
})();
