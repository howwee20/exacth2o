  // Keep media initialization independent of the decorative page effects.
  // Only the opening photograph loads with the page. Each following photograph is
  // fetched and decoded before its slide becomes visible, so rotation never shows a
  // half-loaded image and visitors who leave early never download the rest.
  (() => {
  const cinema = document.querySelector('[data-homepage-slideshow]');
  if (!cinema) return;
  const photos = [...cinema.querySelectorAll('.cinema-slide')];
  let photoIndex = photos.findIndex(photo => photo.classList.contains('is-active')), rotationTimer = null, cinemaVisible = true;
  const ready = new Map();
  function prepare(index) {
    const photo = photos[(index + photos.length) % photos.length];
    if (ready.has(photo)) return ready.get(photo);
    const image = photo.querySelector('img');
    if (image.dataset.srcset) image.srcset = image.dataset.srcset;
    if (image.dataset.src) image.src = image.dataset.src;
    delete image.dataset.src;
    delete image.dataset.srcset;
    const loaded = image.complete && image.naturalWidth
      ? Promise.resolve(true)
      : new Promise(resolve => {
        let requested = image.src;
        image.addEventListener('load', () => resolve(true), { once: true });
        image.addEventListener('error', () => {
          // A failed AVIF switches to its JPEG in the inline onerror handler; keep waiting for that.
          if (image.src !== requested) { requested = image.src; return; }
          resolve(false);
        });
      });
    const decoded = loaded.then(ok => ok && image.decode ? image.decode().then(() => true, () => true) : ok);
    ready.set(photo, decoded);
    return decoded;
  }
  function showPhotograph(index) {
    photoIndex = (index + photos.length) % photos.length;
    photos.forEach((photo, i) => {
      photo.classList.toggle('is-active', i === photoIndex);
      photo.setAttribute('aria-hidden', String(i !== photoIndex));
    });
    // Warm the next photograph during this one's seven seconds.
    void prepare(photoIndex + 1);
  }
  let advancing = false;
  function advance() {
    if (advancing) return;
    advancing = true;
    const next = photoIndex + 1;
    prepare(next).then(ok => {
      advancing = false;
      if (document.hidden || !cinemaVisible) return;
      if (ok) showPhotograph(next);
      else { photoIndex = (next + photos.length) % photos.length; void prepare(photoIndex + 1); }
    });
  }
  function syncRotation() {
    clearInterval(rotationTimer);
    const contentFocused = cinema.contains(document.activeElement);
    if (cinemaVisible && !document.hidden && !contentFocused) {
      rotationTimer = setInterval(advance, 7000);
    }
  }
  cinema.addEventListener('focusin', syncRotation);
  cinema.addEventListener('focusout', () => setTimeout(syncRotation, 0));
  document.addEventListener('visibilitychange', syncRotation);
  window.addEventListener('pageshow', syncRotation);
  window.addEventListener('pagehide', () => clearInterval(rotationTimer));
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { cinemaVisible = entry.isIntersecting; syncRotation(); }).observe(cinema);
  }
  // Begin preparing the second photograph once the page itself has finished loading.
  const warmNext = () => setTimeout(() => prepare(photoIndex + 1), 1500);
  if (document.readyState === 'complete') warmNext(); else window.addEventListener('load', warmNext, { once: true });
  syncRotation();
  })();
