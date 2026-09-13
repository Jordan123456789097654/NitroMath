// Hardware ID (HWID) Device Fingerprinting Utility
export async function getHardwareFingerprint(): Promise<string> {
  try {
    const components: string[] = [];
    components.push(navigator.userAgent || "");
    components.push(navigator.language || "");
    components.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
    components.push(String(navigator.hardwareConcurrency || 4));
    components.push(String(navigator.deviceMemory || 4));
    components.push(Intl.DateTimeFormat().resolvedOptions().timeZone || "");

    // Canvas fingerprinting
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.textBaseline = "top";
      ctx.font = "14px 'Arial'";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#f60";
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = "#069";
      ctx.fillText("NITRO_HWID_SIG#1029384756", 2, 15);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.fillText("NITRO_HWID_SIG#1029384756", 4, 17);
      components.push(canvas.toDataURL());
    }

    // WebGL fingerprinting
    const gl = canvas.getContext("webgl") || (canvas.getContext("experimental-webgl") as WebGLRenderingContext);
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        components.push(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "");
        components.push(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "");
      }
    }

    const rawStr = components.join("||");
    const encoder = new TextEncoder();
    const data = encoder.encode(rawStr);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    return "hwid_fallback_" + Math.random().toString(36).substring(2, 12);
  }
}

export function getStoredHWID(): string {
  let id = localStorage.getItem("nitro_hwid");
  if (!id) {
    id = "hw_" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    localStorage.setItem("nitro_hwid", id);
  }
  return id;
}

export function saveOwnerBypassKey(key: string) {
  localStorage.setItem("nitro_owner_bypass_key", key);
}

export function getOwnerBypassKey(): string | null {
  return localStorage.getItem("nitro_owner_bypass_key");
}
