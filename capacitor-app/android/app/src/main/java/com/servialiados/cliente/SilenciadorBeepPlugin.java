package CAMBIAR.POR.TU.APPID; // <-- pon aqui el MISMO package que tu MainActivity.java

import android.content.Context;
import android.media.AudioManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Silencia los pitidos del reconocedor de voz de Android mientras se dicta
 * y los restaura al terminar. Solo desmutea los streams que ELLA misma muteo.
 */
@CapacitorPlugin(name = "SilenciadorBeep")
public class SilenciadorBeepPlugin extends Plugin {

    private static final int[] STREAMS = {
        AudioManager.STREAM_NOTIFICATION,
        AudioManager.STREAM_SYSTEM,
        AudioManager.STREAM_MUSIC
    };
    private final boolean[] muteados = new boolean[STREAMS.length];
    private boolean activo = false;

    private AudioManager am() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private synchronized void silenciarInterno() {
        if (activo) return;
        AudioManager audio = am();
        if (audio == null) return;
        for (int i = 0; i < STREAMS.length; i++) {
            muteados[i] = false;
            try {
                boolean yaMuteado = android.os.Build.VERSION.SDK_INT >= 23 && audio.isStreamMute(STREAMS[i]);
                if (!yaMuteado) {
                    audio.adjustStreamVolume(STREAMS[i], AudioManager.ADJUST_MUTE, 0);
                    muteados[i] = true;
                }
            } catch (Exception e) {
                // Por ejemplo "No molestar" activo: se ignora ese stream
            }
        }
        activo = true;
    }

    private synchronized void restaurarInterno() {
        if (!activo) return;
        AudioManager audio = am();
        if (audio != null) {
            for (int i = 0; i < STREAMS.length; i++) {
                if (!muteados[i]) continue;
                try {
                    audio.adjustStreamVolume(STREAMS[i], AudioManager.ADJUST_UNMUTE, 0);
                } catch (Exception e) { }
                muteados[i] = false;
            }
        }
        activo = false;
    }

    @PluginMethod
    public void silenciar(PluginCall call) {
        silenciarInterno();
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void restaurar(PluginCall call) {
        restaurarInterno();
        call.resolve(new JSObject());
    }

    @Override
    protected void handleOnDestroy() {
        restaurarInterno();
        super.handleOnDestroy();
    }
}
