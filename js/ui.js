(function () {
  'use strict';

  const toastRegion = document.getElementById('toast-region');
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalTitle = document.getElementById('modal-title');
  const modalDescription = document.getElementById('modal-description');
  const modalInput = document.getElementById('modal-input');
  const confirmButton = document.getElementById('confirm-modal');
  let modalResolve = null;
  let modalHasInput = true;

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast' + (type === 'error' ? ' error' : '');
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', type === 'error' ? 'circle-alert' : 'circle-check');
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(icon, text);
    toastRegion.appendChild(toast);
    refreshIcons();
    window.setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
      window.setTimeout(function () { toast.remove(); }, 180);
    }, 2600);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function highlightCode(value) {
    const tokenPattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
    const keywords = new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'async', 'await', 'import', 'from', 'export', 'default', 'true', 'false', 'null', 'undefined', 'def', 'print', 'in', 'of', 'try', 'catch', 'throw']);
    let output = '';
    let lastIndex = 0;
    let match;
    while ((match = tokenPattern.exec(value)) !== null) {
      output += escapeHtml(value.slice(lastIndex, match.index));
      const token = match[0];
      let className = '';
      if (/^(\/\/|#|\/\*)/.test(token)) className = 'token-comment';
      else if (/^["'`]/.test(token)) className = 'token-string';
      else if (/^\d/.test(token)) className = 'token-number';
      else if (keywords.has(token)) className = 'token-keyword';
      else if (/^\w/.test(token) && /^\s*\(/.test(value.slice(match.index + token.length))) className = 'token-function';
      output += className ? '<span class="' + className + '">' + escapeHtml(token) + '</span>' : escapeHtml(token);
      lastIndex = tokenPattern.lastIndex;
    }
    return output + escapeHtml(value.slice(lastIndex));
  }

  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    const inlineCodes = [];
    text = text.replace(/`([^`]+)`/g, function (_, code) {
      const marker = '\u0000' + inlineCodes.length + '\u0000';
      inlineCodes.push('<code>' + code + '</code>');
      return marker;
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
    return text.replace(/\u0000(\d+)\u0000/g, function (_, index) { return inlineCodes[Number(index)]; });
  }

  function isTableDivider(line) {
    return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.indexOf('-') !== -1;
  }

  function parseTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return cell.trim(); });
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let paragraph = [];
    let listType = '';
    let listItems = [];

    function flushParagraph() {
      if (paragraph.length) output.push('<p>' + paragraph.map(inlineMarkdown).join('<br>') + '</p>');
      paragraph = [];
    }
    function flushList() {
      if (!listItems.length) return;
      const tag = listType === 'ol' ? 'ol' : 'ul';
      output.push('<' + tag + '>' + listItems.map(function (item) { return '<li>' + inlineMarkdown(item) + '</li>'; }).join('') + '</' + tag + '>');
      listItems = [];
      listType = '';
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = line.match(/^\s*```([\w+-]*)\s*$/);
      if (fence) {
        flushParagraph();
        flushList();
        const code = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        const language = escapeHtml(fence[1] || 'code');
        output.push('<div class="code-block"><div class="code-header"><span>' + language + '</span><button class="code-copy" type="button" data-code-copy><i data-lucide="copy"></i>Copy</button></div><pre><code>' + highlightCode(code.join('\n')) + '</code></pre></div>');
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length;
        output.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
        continue;
      }
      if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
        flushParagraph();
        flushList();
        const headers = parseTableRow(line);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          rows.push(parseTableRow(lines[index]));
          index += 1;
        }
        index -= 1;
        output.push('<table><thead><tr>' + headers.map(function (cell) { return '<th>' + inlineMarkdown(cell) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(function (row) {
          return '<tr>' + headers.map(function (_, cellIndex) { return '<td>' + inlineMarkdown(row[cellIndex] || '') + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table>');
        continue;
      }
      const list = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
      if (list) {
        flushParagraph();
        const nextType = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        listItems.push(list[1]);
        continue;
      }
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        output.push('<blockquote>' + inlineMarkdown(quote[1]) + '</blockquote>');
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      flushList();
      paragraph.push(line);
    }
    flushParagraph();
    flushList();
    return output.join('');
  }

  function closeModal(result) {
    if (!modalBackdrop.hidden) modalBackdrop.hidden = true;
    document.removeEventListener('keydown', onModalKeydown);
    const resolve = modalResolve;
    modalResolve = null;
    if (resolve) resolve(result);
  }

  function onModalKeydown(event) {
    if (event.key === 'Escape') closeModal(null);
    if (event.key === 'Enter' && modalHasInput) {
      event.preventDefault();
      confirmButton.click();
    }
  }

  function openModal(options) {
    if (modalResolve) closeModal(null);
    modalTitle.textContent = options.title || '';
    modalDescription.textContent = options.description || '';
    modalHasInput = options.showInput !== false;
    modalInput.hidden = !modalHasInput;
    modalInput.value = options.value || '';
    modalInput.placeholder = options.placeholder || '';
    confirmButton.textContent = options.confirmText || (modalHasInput ? 'Save changes' : 'Confirm');
    modalBackdrop.hidden = false;
    document.addEventListener('keydown', onModalKeydown);
    return new Promise(function (resolve) {
      modalResolve = resolve;
      window.requestAnimationFrame(function () {
        if (modalHasInput) {
          modalInput.focus();
          modalInput.select();
        } else {
          confirmButton.focus();
        }
      });
    });
  }

  document.getElementById('close-modal').addEventListener('click', function () { closeModal(null); });
  document.getElementById('cancel-modal').addEventListener('click', function () { closeModal(null); });
  confirmButton.addEventListener('click', function () {
    if (modalHasInput && !modalInput.value.trim()) {
      modalInput.focus();
      return;
    }
    closeModal(modalHasInput ? modalInput.value.trim() : true);
  });
  modalBackdrop.addEventListener('click', function (event) {
    if (event.target === modalBackdrop) closeModal(null);
  });

  window.RishNovaUI = {
    showToast: showToast,
    refreshIcons: refreshIcons,
    renderMarkdown: renderMarkdown,
    openModal: openModal
  };
})();
