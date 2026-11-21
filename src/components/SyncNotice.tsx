import { useEffect, useState, useSyncExternalStore } from "react";
import { draftReadProblem, syncDrafts } from "../sync";

/**
 * A notice shown while Lantern can't read the unsaved drafts kept on this
 * device, so writing that hasn't reached the server isn't silently stranded.
 */
export function SyncNotice() {
  const unreadable = useSyncExternalStore(draftReadProblem.subscribe, draftReadProblem.get, draftReadProblem.get);
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Show it again if the problem clears and later comes back.
  useEffect(() => {
    if (!unreadable) setDismissed(false);
  }, [unreadable]);

  if (!unreadable || dismissed) return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await syncDrafts();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="sync-notice" role="alert">
      <p>
        <strong>Lantern can't read the unsaved drafts on this device.</strong> Any writing that hadn't reached the
        server yet is still waiting here and won't be sent until it can be read. Try again in a moment. If it keeps
        happening, this browser may be blocking storage for Lantern.
      </p>
      <div className="sync-notice-actions">
        <button className="btn btn-lamp" disabled={retrying} onClick={() => void retry()}>
          {retrying ? "Trying…" : "Try again"}
        </button>
        <button className="btn btn-quiet" onClick={() => setDismissed(true)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
