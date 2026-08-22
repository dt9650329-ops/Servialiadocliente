package com.servialiados.cliente;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import androidx.core.splashscreen.SplashScreen;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

    private static final int PERM_REQUEST_CODE = 1001;
    private static final int LOCATION_REQUEST_CODE = 1002;
    private PermissionRequest pendingRequest;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);

        // FIX CACHÉ: el WebView de Capacitor cachea agresivamente el
        // index.html/JS/CSS igual que un navegador. Cuando instalamos una
        // actualización ENCIMA de la app vieja (sin desinstalar), Android
        // conserva los datos de la app -- incluido ese caché -- y el
        // WebView sigue sirviendo archivos viejos aunque el APK ya tenga
        // los nuevos. Por eso a veces un botón/cambio de frontend "no
        // aparece" hasta que el usuario desinstala y reinstala manualmente.
        // Solución: comparamos el versionCode guardado contra el actual
        // (BuildConfig.VERSION_CODE, que sube en cada build). Si cambió,
        // limpiamos el caché del WebView UNA sola vez -- el usuario no
        // nota nada, solo carga la versión correcta del sitio.
        SharedPreferences prefsVersion = getSharedPreferences("app_version_check", MODE_PRIVATE);
        int currentVersionCode = BuildConfig.VERSION_CODE;
        int savedVersionCode = prefsVersion.getInt("last_version_code", -1);
        if (savedVersionCode != currentVersionCode) {
            bridge.getWebView().clearCache(true);
            prefsVersion.edit().putInt("last_version_code", currentVersionCode).apply();
        }

        // Asegura que el WebView tenga habilitada la geolocalización
        bridge.getWebView().getSettings().setGeolocationEnabled(true);

        bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean needsAudio = false;
                    boolean needsCamera = false;
                    for (String resource : request.getResources()) {
                        if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) needsAudio = true;
                        if (resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) needsCamera = true;
                    }

                    boolean audioGranted = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                    boolean cameraGranted = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;

                    if ((needsAudio && !audioGranted) || (needsCamera && !cameraGranted)) {
                        pendingRequest = request;
                        java.util.ArrayList<String> perms = new java.util.ArrayList<>();
                        if (needsAudio && !audioGranted) perms.add(Manifest.permission.RECORD_AUDIO);
                        if (needsCamera && !cameraGranted) perms.add(Manifest.permission.CAMERA);
                        ActivityCompat.requestPermissions(MainActivity.this, perms.toArray(new String[0]), PERM_REQUEST_CODE);
                    } else {
                        request.grant(request.getResources());
                    }
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(final String origin, final GeolocationPermissions.Callback callback) {
                runOnUiThread(() -> {
                    boolean fineGranted = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                    boolean coarseGranted = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;

                    if (fineGranted || coarseGranted) {
                        callback.invoke(origin, true, false);
                    } else {
                        pendingGeoCallback = callback;
                        pendingGeoOrigin = origin;
                        ActivityCompat.requestPermissions(
                            MainActivity.this,
                            new String[]{ Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION },
                            LOCATION_REQUEST_CODE
                        );
                    }
                });
            }
        });

        // Compartir desde WhatsApp (u otra app) con la app cerrada: el intent
        // ya viene en getIntent(), pero hay que esperar a que el WebView
        // termine de cargar index.html antes de poder llamarle JS.
        new Handler(getMainLooper()).postDelayed(() -> handleSendIntent(getIntent()), 1800);
    }

    // Compartir desde WhatsApp con la app ya abierta en segundo plano:
    // gracias a launchMode="singleTask" esto llega aquí en vez de crear
    // otra instancia de la Activity, y el WebView ya está listo.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSendIntent(intent);
    }

    // Detecta si el intent que abrió/despertó la app es un "Compartir" de
    // texto plano (WhatsApp lo usa tanto para mensajes reenviados como para
    // ubicaciones compartidas) y se lo pasa al chat de ServiBot en el JS.
    private void handleSendIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String type = intent.getType();
        if (Intent.ACTION_SEND.equals(action) && "text/plain".equals(type)) {
            String textoCompartido = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (textoCompartido != null && !textoCompartido.trim().isEmpty()) {
                enviarTextoCompartidoAlWebView(textoCompartido);
            }
        }
    }

    private void enviarTextoCompartidoAlWebView(String texto) {
        String textoEscapado = texto
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "");
        final String js = "if (window.recibirTextoCompartido) { window.recibirTextoCompartido('" + textoEscapado + "'); }";
        runOnUiThread(() -> {
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().evaluateJavascript(js, null);
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode == PERM_REQUEST_CODE && pendingRequest != null) {
            boolean allGranted = true;
            for (int result : grantResults) {
                if (result != PackageManager.PERMISSION_GRANTED) allGranted = false;
            }
            if (allGranted) {
                pendingRequest.grant(pendingRequest.getResources());
            } else {
                pendingRequest.deny();
            }
            pendingRequest = null;
        }

        if (requestCode == LOCATION_REQUEST_CODE && pendingGeoCallback != null) {
            boolean granted = false;
            for (int result : grantResults) {
                if (result == PackageManager.PERMISSION_GRANTED) {
                    granted = true;
                    break;
                }
            }
            pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }
}
