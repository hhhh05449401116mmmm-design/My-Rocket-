/* Decorative home media only. Never participates in bets, clocks or settlement. */
(function (global) {
  'use strict';
  const records = new Map();
  let observer = null;
  let navigationObserver = null;
  let scheduled = false;
  const selector = '.image-banner video.banner-video-engine, .loot-box video.loot-video';

  function homeIsReady() {
    const hub = document.getElementById('game-hub');
    const modal = document.getElementById('loot-box-modal');
    return !document.hidden && !document.body.classList.contains('rocket-starting') &&
      !!hub && !hub.classList.contains('hidden') &&
      !(modal && modal.classList.contains('show'));
  }

  function inViewport(video) {
    const rect = video.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < global.innerHeight &&
      rect.right > 0 && rect.left < global.innerWidth;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    global.requestAnimationFrame(function () { scheduled = false; sync(); });
  }

  function stopMotionFallback(record) {
    if (!record.fallback) return;
    record.fallback.hidden = true;
    record.fallback.removeAttribute('src');
  }

  function showMotionFallback(record) {
    const source = record.video.dataset.motionFallback;
    if (!source || !record.wanted || !homeIsReady()) return;
    if (!record.fallback) {
      const image = document.createElement('img');
      image.className = 'banner-art banner-policy-motion';
      image.alt = '';
      image.setAttribute('aria-hidden', 'true');
      image.addEventListener('error', function () { stopMotionFallback(record); });
      record.video.parentElement.appendChild(image);
      record.fallback = image;
    }
    record.fallback.hidden = false;
    if (!record.fallback.getAttribute('src')) record.fallback.src = source;
  }

  function stop(record) {
    if (record.retryTimer != null) clearTimeout(record.retryTimer);
    record.retryTimer = null;
    record.wanted = false;
    stopMotionFallback(record);
    if (!record.video.paused) record.video.pause();
  }

  function play(record, fromGesture) {
    const video = record.video;
    if (!record.wanted || record.failed || record.pending) return;
    if (record.exhausted && !fromGesture) { showMotionFallback(record); return; }
    if (record.blocked && !fromGesture) { showMotionFallback(record); return; }
    if (!video.paused && video.readyState >= 2) return;
    if (fromGesture) { record.blocked = false; record.exhausted = false; record.attempts = 0; }
    if (video.dataset.src && !video.getAttribute('src')) {
      video.preload = 'metadata';
      video.src = video.dataset.src;
    }
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.setAttribute('muted', '');
    // Native, visible, silent inline media: no seeking and no Canvas copy loop.
    record.pending = true;
    record.attempts += 1;
    try {
      const result = video.play();
      Promise.resolve(result).then(function () {
        record.pending = false;
        record.blocked = false;
        record.attempts = 0;
        if (!record.wanted || !homeIsReady()) stop(record);
      }).catch(function (error) {
        record.pending = false;
        if (error && error.name === 'NotAllowedError') {
          // Respect WebView/OS settings. Keep the poster; a real gesture may retry.
          record.blocked = true;
          video.dataset.mediaPolicyBlocked = '1';
          showMotionFallback(record);
          return;
        }
        if (record.attempts >= 3) {
          record.exhausted = true;
          if (record.retryTimer != null) clearTimeout(record.retryTimer);
          record.retryTimer = null;
          showMotionFallback(record);
          return;
        }
        if (record.wanted && !record.failed && record.attempts < 3 && record.retryTimer == null) {
          record.retryTimer = setTimeout(function () {
            record.retryTimer = null;
            if (homeIsReady() && record.wanted) play(record, false);
          }, 300);
        }
      });
    } catch (error) { record.pending = false; record.blocked = true; }
  }

  function ensureObservers() {
    if (!observer && typeof global.IntersectionObserver === 'function') {
      observer = new global.IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          const record = records.get(entry.target);
          if (!record) return;
          record.visible = entry.isIntersecting && entry.intersectionRatio > 0;
          if (!record.visible) stop(record);
        });
        schedule();
      }, { threshold: 0.01 });
    }
    if (!navigationObserver && typeof global.MutationObserver === 'function' && document.body) {
      navigationObserver = new global.MutationObserver(schedule);
      // Observe only navigation roots, not all gift/Lottie subtrees every frame.
      [document.body, document.getElementById('game-hub'), document.getElementById('loot-box-modal')]
        .filter(Boolean).forEach(function (node) {
          navigationObserver.observe(node, { attributes: true, attributeFilter: ['class', 'hidden'] });
        });
    }
  }

  function register(video) {
    if (records.has(video)) return records.get(video);
    ensureObservers();
    const record = { video: video, visible: inViewport(video), wanted: false, pending: false,
      blocked: false, failed: false, exhausted: false, attempts: 0, retryTimer: null };
    records.set(video, record);
    video.autoplay = false;
    video.removeAttribute('autoplay');
    video.loop = true;
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.removeAttribute('controls');
    video.addEventListener('playing', function () {
      video.classList.add('loot-video-ready');
      delete video.dataset.mediaPolicyBlocked;
      stopMotionFallback(record);
      if (!record.wanted || !homeIsReady()) stop(record);
    });
    video.addEventListener('error', function () {
      record.failed = true;
      video.classList.remove('loot-video-ready');
      video.classList.add('home-media-failed');
      stop(record);
    });
    video.addEventListener('loadeddata', schedule);
    video.addEventListener('canplay', schedule);
    if (observer) observer.observe(video);
    if (!record.visible || !homeIsReady()) stop(record);
    return record;
  }

  function sync(fromGesture) {
    document.querySelectorAll(selector).forEach(register);
    const ready = homeIsReady();
    records.forEach(function (record, video) {
      if (!video.isConnected) {
        stop(record);
        if (observer) observer.unobserve(video);
        records.delete(video);
        return;
      }
      // Measure only on lifecycle changes, never for every decoded video frame.
      record.visible = inViewport(video);
      const wanted = ready && record.visible;
      if (wanted && !record.wanted && record.exhausted) { record.exhausted = false; record.attempts = 0; }
      record.wanted = wanted;
      if (!record.wanted) stop(record);
      else play(record, !!fromGesture);
    });
  }

  global.RocketHomeMedia = { sync: sync, register: register };
  document.addEventListener('visibilitychange', function () { sync(); });
  global.addEventListener('pageshow', schedule);
  global.addEventListener('resize', schedule, { passive: true });
  if (typeof global.IntersectionObserver !== 'function')
    global.addEventListener('scroll', schedule, { passive: true, capture: true });
  document.addEventListener('pointerdown', function () { sync(true); }, { passive: true });
  document.addEventListener('touchend', function () { sync(true); }, { passive: true });
})(window);
