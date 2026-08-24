import { BrowserQRCodeReader } from "@zxing/browser";
import { useEffect, useRef, useState } from "react";
import { appendCameraErrorDetails, cameraErrorName } from "./-qr-pairing-scanner-error";

type ScannerControls = { stop: () => void };

export function QrPairingScanner({ onScan, onClose }: { onScan: (value: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reader = new BrowserQRCodeReader();
    let active = true;
    let controls: ScannerControls | undefined;
    const video = videoRef.current;

    const stopVideo = () => {
      controls?.stop();
      controls = undefined;

      const stream = video?.srcObject;
      if (stream && "getTracks" in stream && typeof stream.getTracks === "function") {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
      }
      if (video) video.srcObject = null;
    };

    const setCameraError = (cause: unknown) => {
      const name = cameraErrorName(cause);
      const setDetailedError = (message: string) => setError(appendCameraErrorDetails(message, cause));

      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        const secureContext = typeof window !== "undefined" && window.isSecureContext;
        setDetailedError(
          secureContext
            ? "Camera access is unavailable in this environment."
            : "Camera access requires HTTPS or localhost.",
        );
        return;
      }
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setDetailedError("Camera permission was denied. Allow camera access in your browser or device settings.");
        return;
      }
      if (name === "NotFoundError") {
        setDetailedError("No camera was found.");
        return;
      }
      if (name === "NotReadableError" || name === "AbortError") {
        setDetailedError("Could not start the camera. Make sure another app is not using it.");
        return;
      }
      setDetailedError("Camera access failed.");
    };

    const start = async () => {
      if (!video) {
        setError("Could not initialize the camera preview.");
        return;
      }
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setCameraError(new Error("getUserMedia is unavailable"));
        return;
      }
      try {
        controls = await reader.decodeFromConstraints(
          { audio: false, video: { facingMode: { ideal: "environment" } } },
          video,
          (result, _decodeError, scannerControls) => {
            if (!active || !result) return;
            active = false;
            scannerControls.stop();
            onScan(result.getText());
          },
        );
        if (!active) stopVideo();
      } catch (cause) {
        if (active) setCameraError(cause);
      }
    };
    void start();
    return () => {
      active = false;
      stopVideo();
    };
  }, [onScan]);

  return (
    <section className="mb-4 grid gap-3" aria-label="QR code scanner">
      <div className="relative aspect-square max-w-96 overflow-hidden rounded-2xl border border-[#7fe7c6]/45 bg-[#080b0e]">
        <video className="block size-full object-cover" ref={videoRef} autoPlay muted playsInline />
        <span className="pointer-events-none absolute inset-[16%] rounded-[0.7rem] border-2 border-white/80 shadow-[0_0_0_999px_rgb(0_0_0_/_20%)]" />
      </div>
      <p className="m-0 text-[0.82rem] text-[#638f6b]" role={error ? "alert" : undefined}>
        {error ?? "Scan the QR code shown by muximo pair in this app."}
      </p>
      <button
        className="flex min-h-[37px] w-full items-center justify-center rounded-[9px] border border-[#214d2b] bg-transparent text-[0.63rem] text-[#78a77f] transition-colors hover:border-[#3c8248] hover:text-[#b6eabd] max-[920px]:min-h-11"
        type="button"
        onClick={onClose}
      >
        Close camera
      </button>
    </section>
  );
}
