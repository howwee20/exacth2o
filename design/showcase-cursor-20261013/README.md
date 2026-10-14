# Cursor-led ExactH2O tour

24 seconds at 60 fps, 1920 × 1200. Source images are complete, unmodified browser captures of the published demo, taken through its actual controls. The edit adds a smoothly eased pointer, a brief click halo, restrained camera movement, short UI transitions and the existing brand close. It does not invent product screens or change the measurements.

The flow opens History and Export on the recorded drought experiment, then selects Drought in the recovery scenario (which opens the expanded chart), turns on Overlay, types and saves a comparison, and closes the expanded chart. The report shown covers the selected last-three-days window. Recovery and irrigation scenes are derived demo scenarios, identified in the video and captions.

Rebuild with `python3 scripts/render-showcase.py`. Requires Pillow and FFmpeg; `FFMPEG` can select a binary. `SHOWCASE_FONTS` can select a directory containing Arial.ttf and Arial Bold.ttf. `SHOWCASE_STILLS_ONLY=1` writes review stills instead of rendering the video. `SHOWCASE_SCRATCH` controls the temporary output directory.

The versioned MP4, WebM, poster, captions and provenance manifest ship together. The earlier capture set and media remain available for cached pages.
