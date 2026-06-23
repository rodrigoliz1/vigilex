const PUBLIC_VAPID_KEY = 'BGPfCgEqN0WXTKoYsSU4hTEMQLbn0yYST0gqguedC0kSEkyGEYgqtUEeUAdTKL82772lp_ynWG69rG9K61baIDU';

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
    return outputArray;
}

// Esta es la función que ejecutará el botón en tu iPhone
window.activarNotificacionesPush = async function() {
    const tokenGlobal = localStorage.getItem('vigilex_token');
    const userGlobal = localStorage.getItem('usuario_actual');
    
    if (!tokenGlobal || !userGlobal) return alert("Inicia sesión en VIGILEX primero.");

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return alert("Tu dispositivo no soporta notificaciones Web Push de Apple/Google.");
    }

    try {
        // 1. Pedimos permiso (Al hacer clic, el iPhone sí te mostrará la alerta)
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            return alert("Debes permitir las notificaciones para vincular el dispositivo.");
        }

        // 2. Registramos el Service Worker (El Zombie)
        const register = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        // 3. Creamos la suscripción única de este celular
        let subscription = await register.pushManager.getSubscription();
        if (!subscription) {
            subscription = await register.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY)
            });
        }

        // 4. Guardamos las coordenadas en tu base de datos Neon (SQL)
        const response = await fetch('/.netlify/functions/suscripcion_push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenGlobal}` },
            body: JSON.stringify({ username: userGlobal, subscription })
        });

        const data = await response.json();
        if(data.success) {
            alert("✅ ¡Dispositivo vinculado a la red VIGILEX exitosamente! Ya puedes cerrar la app y recibirás las alertas.");
        } else {
            alert("Error al guardar en la base de datos.");
        }

    } catch (error) {
        console.error("Error Push:", error);
        alert("Error técnico al vincular el dispositivo.");
    }
};

// (Opcional) Si el usuario ya dio permiso antes, registramos el SW silenciosamente al cargar para que no se pierda la conexión
document.addEventListener('DOMContentLoaded', async () => {
    if ('serviceWorker' in navigator && Notification.permission === 'granted') {
        navigator.serviceWorker.register('/sw.js');
    }
});