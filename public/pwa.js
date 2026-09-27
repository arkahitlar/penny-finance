// Installation is optional: an unavailable worker must not block the journal.
if ('serviceWorker' in navigator && window.isSecureContext) {
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // The online app remains usable if offline-screen installation fails.
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
  // No forced activation or reload: leave open expense forms undisturbed.
}
