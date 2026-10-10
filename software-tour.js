(() => {
  const video = document.getElementById('softwareTourVideo');
  const play = document.getElementById('softwareTourPlay');
  const error = document.getElementById('softwareTourError');
  if (!video || !play || !error) return;
  // Keep native controls when JavaScript is unavailable. Never autoplay or loop.
  video.controls = false;
  play.hidden = false;
  play.addEventListener('click', async () => {
    play.hidden = true;
    error.hidden = true;
    video.controls = true;
    try {
      if (video.ended) video.currentTime = 0;
      await video.play();
      video.focus({ preventScroll: true });
    } catch {
      play.hidden = false;
      error.hidden = false;
    }
  });
  video.addEventListener('ended', () => {
    play.querySelector('span').textContent = 'Watch again';
    play.hidden = false;
  });
  video.addEventListener('play', () => { play.hidden = true; error.hidden = true; });
  video.addEventListener('error', () => { video.controls = true; play.hidden = true; error.hidden = false; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause(); });
})();
