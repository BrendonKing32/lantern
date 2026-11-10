import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { SharedProject } from "../../shared/types";

interface Props {
  token: string;
}

export function PublicShareView({ token }: Props) {
  const [book, setBook] = useState<SharedProject | null>(null);
  const [chapterId, setChapterId] = useState("");
  const [content, setContent] = useState("");
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let live = true;
    api.getSharedProject(token).then((data) => {
      if (!live) return;
      setBook(data);
      setChapterId(data.chapters[0]?.id ?? "");
      if (!data.chapters.length) setError("This novel has no chapters to review.");
    }).catch(() => {
      if (live) setError("This review link is invalid or has been revoked.");
    });
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    if (!chapterId) return;
    let live = true;
    setLoadingChapter(true);
    setError("");
    setContent("");
    setFeedback("");
    api.getSharedChapter(token, chapterId).then((chapter) => {
      if (live) setContent(chapter.content);
    }).catch(() => {
      if (live) setError("This chapter is no longer available.");
    }).finally(() => {
      if (live) setLoadingChapter(false);
    });
    return () => {
      live = false;
    };
  }, [token, chapterId]);

  const sendComment = async (event: FormEvent) => {
    event.preventDefault();
    const text = comment.trim();
    if (!chapterId || !text || sending) return;
    setSending(true);
    setFeedback("");
    try {
      await api.postShareComment(token, chapterId, displayName.trim(), text);
      setComment("");
      setFeedback("Sent privately to the author. Thank you.");
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Couldn't send feedback. Try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="public-share">
      <header className="public-share-head">
        <p className="public-share-brand">Lantern · Manuscript review</p>
        <h1>{book?.project.title ?? "Shared manuscript"}</h1>
      </header>
      {error && <p className="public-share-error" role="alert">{error}</p>}
      {book && book.chapters.length > 0 && (
        <>
          <label className="public-chapter-select">
            <span>Chapter</span>
            <select value={chapterId} onChange={(event) => setChapterId(event.target.value)}>
              {book.chapters.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>{chapter.title}</option>
              ))}
            </select>
          </label>
          <article className="public-manuscript">
            <h2>{book.chapters.find((chapter) => chapter.id === chapterId)?.title}</h2>
            {loadingChapter ? <p>Loading chapter…</p> : <pre>{content}</pre>}
          </article>
          <section className="public-feedback">
            <h2>Send private feedback</h2>
            <p>Your comment goes only to the author. Other reviewers cannot see it.</p>
            <form onSubmit={(event) => void sendComment(event)}>
              <label>
                <span>Your name (optional)</span>
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} />
              </label>
              <label>
                <span>Comment</span>
                <textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={5000} required rows={5} />
              </label>
              {feedback && <p className="public-feedback-status" role="status">{feedback}</p>}
              <button className="btn btn-lamp" disabled={sending || !comment.trim()}>
                {sending ? "Sending…" : "Send privately"}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
