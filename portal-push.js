// Push-only worker for the research portal.
self.addEventListener("push", (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const url = new URL(data.url || "/portal", self.location.origin);
  event.waitUntil(
    self.registration.showNotification(String(data.title || "ExactH2O"), {
      body: String(data.body || ""),
      icon: "/portal-icon-192.png",
      tag: data.tag,
      data: {
        url:
          url.origin === self.location.origin && url.pathname === "/portal"
            ? url.href
            : "/portal",
      },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data?.url || "/portal"),
  );
});
