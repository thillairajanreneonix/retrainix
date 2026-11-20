/**
 * The camera a person chose on the Project setup screen, remembered in this browser so the
 * Dashboard can show the same camera live. Only the device id and its name are kept, and only
 * here: the id and the name are never sent to the API. (The picture is another matter: while
 * "Label with the model" is on, the Dashboard sends still frames of it - see LiveCameraView.)
 */
export type ChosenCamera = { id: string; label: string };

const KEY = "retrainix.camera";
export const CAMERA_CHANGED_EVENT = "retrainix:camera-changed";

export function readChosenCamera(): ChosenCamera | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ChosenCamera>;
    return typeof value.id === "string" && value.id ? { id: value.id, label: typeof value.label === "string" ? value.label : "Camera" } : null;
  } catch {
    return null; // private window or blocked storage: the Dashboard then asks to choose a camera
  }
}

export function rememberChosenCamera(camera: ChosenCamera): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(camera));
  } catch {
    /* without storage the choice simply lasts for this page only */
  }
  window.dispatchEvent(new Event(CAMERA_CHANGED_EVENT));
}

export function forgetChosenCamera(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
  window.dispatchEvent(new Event(CAMERA_CHANGED_EVENT));
}

export type CameraProblem = { title: string; detail: string };

/** Why this page cannot open a camera at all, or null when it can. */
export function cameraUnavailable(): CameraProblem | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return {
      title: "This page cannot use a camera",
      detail:
        "The browser gives a page the camera only when it was opened over https or on localhost, and only in a current browser. Open the app that way and try again.",
    };
  }
  return null;
}

/** A browser camera error, in words a person can act on. */
export function cameraProblemFrom(err: unknown): CameraProblem {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: "The camera was not allowed",
      detail:
        "The browser or the system refused camera access for this site. Allow the camera for this site (the camera or lock icon in the address bar), then try again.",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      title: "No camera was found",
      detail: "This computer reports no camera, or the one chosen is no longer attached. Plug the camera in, then try again.",
    };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: "The camera could not be started",
      detail:
        "It is attached but would not deliver video. Another program, such as a camera viewer, may be holding it. Close that program, then try again.",
    };
  }
  return {
    title: "The camera could not be started",
    detail: err instanceof Error && err.message ? err.message : "The browser gave no reason.",
  };
}
