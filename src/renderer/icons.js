(() => {
  const symbols = {
    play: '▶', square: '■', settings: '⚙', globe: '◉', 'user-plus': '+', users: '♟',
    'log-out': '↪', power: '⏻', plus: '+', 'rotate-cw': '↻', zap: 'ϟ', swords: '⚔',
    shield: '◆', coins: '●', gem: '♦', award: '★', 'book-open': '▤', save: '✓', x: '×', user: '●', pause: 'Ⅱ',
  };
  window.lucide = {
    createIcons() {
      document.querySelectorAll('i[data-lucide]').forEach(element => {
        element.textContent = symbols[element.dataset.lucide] || '•';
        element.classList.add('local-icon');
        element.setAttribute('aria-hidden', 'true');
      });
    },
  };
})();
