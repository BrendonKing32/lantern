import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError } from "../api";
import { migrateShareToken, shareTokenKey } from "../shareTokens";
import type { Milestone, ShareComment, ShareLink } from "../../shared/types";

interface Props {
  projectId: string;
  projectTitle: string;
  onClose: () => void;
}

function shareUrl(token: string): string {
  return new URL(`/share/${encodeURIComponent(token)}`, window.location.origin).toString();
}

export function ShareDialog({ projectId, projectTitle, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [comments, setComments] = useState<ShareComment[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [label, setLabel] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [trackProgress, setTrackProgress] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all([api.shares(projectId), api.shareComments(projectId), api.milestones(projectId)])
      .then(async ([shares, feedback, saved]) => {
        const found: Record<string, string> = {};
        try {
          const migration = await migrateShareToken(localStorage, projectId, shares.map((share) => share.id));
          if (live && migration === "deferred") setError("Couldn't check the saved review link. Open Share again when you're connected.");
          for (const share of shares) {
            const token = localStorage.getItem(shareTokenKey(share.id));
            if (token) found[share.id] = token;
          }
        } catch { /* Link management still works without local storage. */ }
        if (live) { setLinks(shares); setComments(feedback); setMilestones(saved); setTokens(found); }
      }).catch((e) => { if (live) setError(describeError(e)); });
    return () => { live = false; };
  }, [projectId]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try {
      if (!navigator.onLine) throw new Error("Review links need a connection. Go online and try again.");
      await action();
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api.createShare(projectId, { label, milestoneId: milestoneId || undefined, trackProgress });
      setLinks((current) => [...(current ?? []), result]);
      setTokens((current) => ({ ...current, [result.id]: result.token }));
      try { localStorage.setItem(shareTokenKey(result.id), result.token); } catch { /* Copy remains available in this dialog. */ }
      setLabel("");
    });
  };

  const update = (id: string, patch: { label?: string; trackProgress?: boolean }) => void run(async () => {
    const updated = await api.updateShare(id, patch);
    setLinks((current) => current?.map((link) => link.id === id ? updated : link) ?? null);
    setComments((current) => current.map((comment) => comment.share_id === id ? { ...comment, share_label: updated.label } : comment));
  });

  const revoke = (id: string) => {
    if (!confirm("Revoke this review link? Anyone using it will lose access.")) return;
    void run(async () => {
      await api.revokeShare(id);
      setLinks((current) => current?.filter((link) => link.id !== id) ?? null);
      setTokens((current) => { const next = { ...current }; delete next[id]; return next; });
      try { localStorage.removeItem(shareTokenKey(id)); } catch { /* The link is already revoked. */ }
    });
  };

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(tokens[id]));
      setCopied(id); window.setTimeout(() => setCopied(""), 1800);
    } catch { setError("Couldn't copy the link. Select and copy it manually."); }
  };

  const removeComment = (comment: ShareComment) => void run(async () => {
    await api.deleteShareComment(projectId, comment.id);
    setComments((list) => list.filter((item) => item.id !== comment.id));
    setLinks((list) => list?.map((link) => link.id === comment.share_id ? { ...link, feedback_count: link.feedback_count - 1 } : link) ?? null);
  });
  const displayed = comments.filter((comment) => !filter || comment.share_id === filter);
  const feedbackLinks = Array.from(new Map(comments.map((comment) => [comment.share_id, comment.share_label])).entries());

  return (
    <dialog ref={ref} className="share-dialog" onClose={onClose} aria-labelledby="share-title">
      <div className="share-dialog-body">
        <header className="share-head">
          <div><h2 id="share-title">Share “{projectTitle}”</h2>
            <p>Anyone with an unlisted link can read the manuscript and send private feedback.</p></div>
          <button className="icon-btn" aria-label="Close sharing" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </header>
        {links === null && !error && <p className="share-note">Checking review links…</p>}
        {links?.length === 0 && <p className="share-note">No review links are active.</p>}
        {links?.map((link) => <div className="share-link-controls" key={link.id}>
          <strong>{link.label || "Review link"}</strong>
          <p className="share-note">{link.milestone_id ? `Milestone “${link.milestone_name}”` : "Current chapters"} · {new Date(link.created_at).toLocaleDateString()} · {link.feedback_count} feedback</p>
          {tokens[link.id] ? <div className="share-link-row">
            <input aria-label={`Review link for ${link.label || "Review link"}`} readOnly value={shareUrl(tokens[link.id])} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={() => void copy(link.id)}>{copied === link.id ? "Copied" : "Copy link"}</button>
          </div> : <p className="share-note">This device doesn't have a copy of this link. Create a new link to share from this device.</p>}
          <label><input type="checkbox" checked={!!link.track_progress} disabled={busy} onChange={(e) => update(link.id, { trackProgress: e.target.checked })} /> Show me how far readers get</label>
          <div className="share-actions">
            <button className="btn btn-quiet" disabled={busy} onClick={() => {
              const next = prompt("Rename this review link:", link.label);
              if (next !== null) update(link.id, { label: next });
            }}>Rename</button>
            <button className="btn btn-quiet" disabled={busy} onClick={() => revoke(link.id)}>Revoke</button>
          </div>
        </div>)}
        <form className="share-link-controls" onSubmit={create}>
          <h3>New review link</h3>
          <p className="share-note">Reading progress isn't recorded yet. This setting will apply when it's available.</p>
          <label>Label <input required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
          <label>What to share <select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
            <option value="">Current chapters</option>
            {milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>Milestone “{milestone.name}”</option>)}
          </select></label>
          <label><input type="checkbox" checked={trackProgress} onChange={(e) => setTrackProgress(e.target.checked)} /> Show me how far readers get</label>
          <button className="btn btn-lamp" disabled={busy || links === null || !label.trim()}>Create review link</button>
        </form>
        {error && <p className="share-error" role="alert">{error}</p>}
        <section className="share-feedback" aria-label="Private reviewer feedback">
          <h3>Private feedback</h3>
          <p>Only you can see these comments. Reviewers can’t read or reply to them.</p>
          <label>Filter by link <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All links</option>
            {feedbackLinks.map(([id, name]) => <option key={id} value={id}>{name || "Review link"}</option>)}
          </select></label>
          {displayed.length === 0 ? <p className="share-note">No feedback yet.</p> : <ol>
            {displayed.map((comment) => <li key={comment.id} className="share-comment">
              <div className="share-comment-meta"><strong>{comment.display_name || "Anonymous"}</strong>
                <span>{comment.share_label || "Review link"} · {comment.chapter_title} · {new Date(comment.created_at).toLocaleString()}</span></div>
              <p>{comment.body}</p>
              <button className="btn btn-quiet" onClick={() => removeComment(comment)}>Delete feedback</button>
            </li>)}
          </ol>}
        </section>
        <footer className="share-footer"><button className="btn btn-quiet" onClick={onClose}>Close</button></footer>
      </div>
    </dialog>
  );
}
