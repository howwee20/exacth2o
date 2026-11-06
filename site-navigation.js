(() => {
  const menu = document.getElementById('mobileMenu');
  const trigger = document.getElementById('hamburger');
  const background = document.querySelectorAll('main, footer, nav .nav-logo, nav .nav-links');
  const mobile = window.matchMedia('(max-width: 900px)');
  const scrollRoot = document.documentElement;
  let previousOverflow = '';

  function setOpen(open, restoreFocus = true) {
    const wasOpen = menu.classList.contains('active');
    if (open && !wasOpen) previousOverflow = scrollRoot.style.overflow;
    menu.classList.toggle('active', open);
    trigger.classList.toggle('active', open);
    trigger.setAttribute('aria-expanded', String(open));
    trigger.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    menu.setAttribute('aria-hidden', String(!open));
    background.forEach(element => { element.inert = open; });
    scrollRoot.style.overflow = open ? 'hidden' : previousOverflow;
    // Restore the scroll container before returning focus. Focusing the sticky
    // trigger while scrolling is locked can scroll the page back to the top.
    if (!open && wasOpen && restoreFocus) trigger.focus({ preventScroll: true });
    if (open) menu.querySelector('.mob-close').focus({ preventScroll: true });
  }

  window.toggleMenu = () => setOpen(!menu.classList.contains('active'));
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Tab') {
      const items = [...menu.querySelectorAll('button, a[href]')];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  mobile.addEventListener('change', () => {
    if (!mobile.matches && menu.classList.contains('active')) {
      setOpen(false, false);
      document.querySelector('nav .nav-logo').focus({ preventScroll: true });
    }
  });
})();
