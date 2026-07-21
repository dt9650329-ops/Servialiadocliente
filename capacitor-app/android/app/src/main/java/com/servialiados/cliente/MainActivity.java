package com.servialiados.cliente;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
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
