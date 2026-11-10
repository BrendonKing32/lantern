import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../api";
import type { ShareComment } from "../../shared/types";

interface Props {
  projectId: string;
  projectTitle: string;
  onClose: () => void;
}

const tokenKey = (projectId: string) => `lantern:share:${projectId}`;

function shareUrl(token: string): string {
  return new URL(`/share/${encodeURIComponent(token)}`, window.location.origin).toString();
}

export function ShareDialog({ projectId, projectTitle, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const [comments, setComments] = useState<ShareComment[]>([]);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all([
      api.shareStatus(projectId),
      api.shareComments(projectId),
    ]).then(async ([share, feedback]) => {
      if (!live) return;
      setActive(share.active);
      setComments(feedback);
      if (!share.active) return;
      let token = "";
      try {
        token = localStorage.getItem(tokenKey(projectId)) ?? "";
      } catch {
        // The current link can still be managed without local storage.
      }
      if (!token) return;
      try {
        await api.getSharedProject(token);
        if (live) setLink(shareUrl(token));
      } catch {
        try {
          localStorage.removeItem(tokenKey(projectId));
        } catch {
          // Forgetting a stale convenience copy is best-effort.
        }
      }
    }).catch((e) => {
      if (live) setError(describeError(e));
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      if (active && !confirm("Create a new link? The current link will stop working.")) return;
      if (active) {
        await api.revokeShare(projectId);
        setActive(false);
        setLink("");
        try {
          localStorage.removeItem(tokenKey(projectId));
        } catch {
          // The old link has already been revoked on the server.
        }
      }
      const result = await api.createShare(projectId);
      const url = shareUrl(result.token);
      setActive(true);
      setLink(url);
      try {
        localStorage.setItem(tokenKey(projectId), result.token);
      } catch {
        // The link remains available in this dialog for copying.
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!confirm("Revoke this review link? Anyone using it will lose access.")) return;
    setBusy(true);
    setError("");
    try {
      await api.revokeShare(projectId);
      setActive(false);
      setLink("");
      try {
        localStorage.removeItem(tokenKey(projectId));
      } catch {
        // Revocation is already complete on the server.
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy the link. Select and copy it manually.");
    }
  };

  const removeComment = async (comment: ShareComment) => {
    try {
      await api.deleteShareComment(projectId, comment.id);
      setComments((list) => list.filter((item) => item.id !== comment.id));
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <dialog ref={ref} className="share-dialog" onClose={onClose} aria-labelledby="share-title">
      <div className="share-dialog-body">
        <header className="share-head">
          <div>
            <h2 id="share-title">Share “{projectTitle}”</h2>
            <p>Anyone with the unlisted link can read the manuscript and send private feedback.</p>
          </div>
          <button className="icon-btn" aria-label="Close sharing" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </header>

        {active === null && !error && <p className="share-note">Checking review link…</p>}
        {active === false && (
          <div className="share-link-controls">
            <p className="share-note">No review link is active. The link stays available until you revoke it.</p>
            <button className="btn btn-lamp" onClick={() => void create()} disabled={busy}>
              {busy ? "Creating…" : "Create review link"}
            </button>
          </div>
        )}
        {active && (
          <div className="share-link-controls">
            <p className="share-note">Link active. Reviewers cannot see one another’s feedback.</p>
            {link ? (
              <div className="share-link-row">
                <input aria-label="Review link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
              </div>
            ) : (
              <p className="share-note">This device doesn't have the link copy. Create a new link to replace the current one.</p>
            )}
            <div className="share-actions">
              <button className="btn btn-quiet" onClick={() => void create()} disabled={busy}>
                Replace link
              </button>
              <button className="btn btn-quiet" onClick={() => void revoke()} disabled={busy}>
                Revoke link
              </button>
            </div>
          </div>
        )}

        {error && <p className="share-error" role="alert">{error}</p>}

        <section className="share-feedback" aria-label="Private reviewer feedback">
          <h3>Private feedback</h3>
          <p>Only you can see these comments. Reviewers can’t read or reply to them.</p>
          {comments.length === 0 ? (
            <p className="share-note">No feedback yet.</p>
          ) : (
            <ol>
              {comments.map((comment) => (
                <li key={comment.id} className="share-comment">
                  <div className="share-comment-meta">
                    <strong>{comment.display_name || "Anonymous"}</strong>
                    <span>{comment.chapter_title} · {new Date(comment.created_at).toLocaleString()}</span>
                  </div>
                  <p>{comment.body}</p>
                  <button className="btn btn-quiet" onClick={() => void removeComment(comment)}>Delete feedback</button>
                </li>
              ))}
            </ol>
          )}
        </section>
        <footer className="share-footer">
          <button className="btn btn-quiet" onClick={onClose}>Close</button>
        </footer>
      </div>
    </dialog>
  );
}
