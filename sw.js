// sw.js - Service Worker de VIGILEX
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Aquí es donde el iPhone "escucha" el pulso del servidor
self.addEventListener('push', function(event) {
    if (event.data) {
        const data = event.data.json();
        const options = {
            body: data.body,
            icon: '/logo-vigilex.png',
            badge: '/logo-vigilex.png', // El ícono chiquito que sale en la barra superior
            vibrate: [200, 100, 200, 100, 200], // Patrón de vibración
            data: { url: data.url || '/mensajes.html' }
        };
        event.waitUntil(
            self.registration.showNotification(data.title, options)
        );
    }
});

// Qué pasa si el usuario toca la notificación en su pantalla bloqueada
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url)
    );
});