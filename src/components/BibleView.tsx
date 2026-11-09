import { useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "../api";
import { chapterText } from "../sync";
import { findLinks, linkKey, stripLinks } from "../../shared/wikilinks";
import { BIBLE_KINDS, type BibleEntry, type BibleKind, type ChapterMeta } from "../../shared/types";

export const KIND_LABEL: Record<BibleKind, string> = {
  character: "Characters",
  place: "Places",
  thing: "Things",
  note: "Notes",
};
export const KIND_ONE: Record<BibleKind, string> = {
  character: "Character",
  place: "Place",
  thing: "Thing",
  note: "Note",
};

interface Props {
  projectId: string;
  entries: BibleEntry[];
  onEntries: (update: (list: BibleEntry[]) => BibleEntry[]) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  chapters: ChapterMeta[];
  onOpenChapter: (id: string) => void;
  offline: boolean;
}

/** The story guide: characters, places, things and notes for this novel. */
export function BibleView({ projectId, entries, onEntries, selectedId, onSelect, chapters, onOpenChapter, offline }: Props) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = entries.find((e) => e.id === selectedId) ?? null;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? entries.filter((e) => [e.name, ...e.aliases].some((n) => n.toLowerCase().includes(q)) || e.body.toLowerCase().includes(q))
      : entries;
  }, [entries, query]);

  const create = async (kind: BibleKind) => {
    // A unique placeholder name, renamed straight away in the editor.
    const base = `New ${KIND_ONE[kind].toLowerCase()}`;
    const taken = new Set(entries.flatMap((e) => [e.name, ...e.aliases].map(linkKey)));
    let name = base;
    for (let n = 2; taken.has(linkKey(name)); n++) name = `${base} ${n}`;
    try {
      const e = await api.createEntry(projectId, { name, kind });
      onEntries((list) => [...list, e]);
      onSelect(e.id);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <section className={`bible${selected ? " has-selection" : ""}`} aria-label="Story Guide">
      <div className="bible-list">
        <input
          className="bible-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the story guide"
          aria-label="Search the story guide"
        />
        <div className="bible-new" role="group" aria-label="New entry">
          {BIBLE_KINDS.map((k) => (
            <button key={k} className="btn btn-quiet" onClick={() => create(k)} disabled={offline}>
              + {KIND_ONE[k]}
            </button>
          ))}
        </div>
        {offline && <p className="bible-note">Offline: entries can be read but not changed.</p>}
        {error && (
          <p className="bible-note bible-error" role="alert">
            {error}
          </p>
        )}
        {entries.length === 0 && (
          <p className="bible-note">
            Nothing here yet. Add the people, places and things in your novel, then link to them from a chapter
            by typing <code>[[</code> and a name.
          </p>
        )}
        {BIBLE_KINDS.map((k) => {
          const group = shown.filter((e) => e.kind === k);
          if (!group.length) return null;
          return (
            <div key={k} className="bible-group">
              <h3>{KIND_LABEL[k]}</h3>
              <ul>
                {group.map((e) => (
                  <li key={e.id}>
                    <button
                      className={`bible-item${e.id === selectedId ? " is-selected" : ""}`}
                      aria-current={e.id === selectedId ? "true" : undefined}
                      onClick={() => onSelect(e.id)}
                    >
                      <span className="bible-item-name">{e.name}</span>
                      {e.aliases.length > 0 && <span className="bible-item-aka">{e.aliases.join(", ")}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {query && shown.length === 0 && <p className="bible-note">No entries match “{query}”.</p>}
      </div>

      <div className="bible-detail">
        {selected && (
          <button className="btn btn-quiet bible-back" onClick={() => onSelect(null)}>
            ← All entries
          </button>
        )}
        {selected ? (
          <EntryEditor
            key={selected.id}
            entry={selected}
            offline={offline}
            onSaved={(e) => onEntries((list) => list.map((x) => (x.id === e.id ? e : x)))}
            onDeleted={() => {
              onEntries((list) => list.filter((x) => x.id !== selected.id));
              onSelect(null);
            }}
            chapters={chapters}
            onOpenChapter={onOpenChapter}
          />
        ) : (
          <p className="bible-empty">
            {entries.length ? "Choose an entry to read or edit it." : "Your story guide keeps track of who and what is in the book."}
          </p>
        )}
      </div>
    </section>
  );
}

interface EditorProps {
  entry: BibleEntry;
  offline: boolean;
  onSaved: (e: BibleEntry) => void;
  onDeleted: () => void;
  chapters: ChapterMeta[];
  onOpenChapter: (id: string) => void;
}

const SAVE_DELAY = 800;

function EntryEditor({ entry, offline, onSaved, onDeleted, chapters, onOpenChapter }: EditorProps) {
  const [name, setName] = useState(entry.name);
  const [aliases, setAliases] = useState(entry.aliases.join(", "));
  const [body, setBody] = useState(entry.body);
  const [status, setStatus] = useState<"saved" | "saving" | "editing" | string>("saved");
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(entry);
  latest.current = entry;

  const save = async (patch: Partial<Pick<BibleEntry, "name" | "kind" | "aliases" | "body">>) => {
    setStatus("saving");
    try {
      const e = await api.updateEntry(entry.id, patch);
      onSaved(e);
      setStatus("saved");
      return e;
    } catch (err) {
      setStatus(describeError(err));
      return null;
    }
  };

  // Notes save shortly after you stop typing, and on leaving the entry.
  const bodyRef = useRef(body);
  bodyRef.current = body;
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (bodyRef.current !== latest.current.body) void api.updateEntry(entry.id, { body: bodyRef.current }).then(onSaved, () => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const commitName = async () => {
    const n = name.trim();
    if (!n || n === entry.name) return setName(entry.name);
    const e = await save({ name: n });
    if (!e) setName(entry.name);
  };
  const commitAliases = async () => {
    const list = aliases.split(",").map((a) => a.trim()).filter(Boolean);
    if (list.join("\n") === entry.aliases.join("\n")) return;
    const e = await save({ aliases: list });
    setAliases((e ?? entry).aliases.join(", "));
  };

  const remove = async () => {
    if (!confirm(`Delete “${entry.name}” from the story guide? Links to it in chapters stay as plain [[text]].`)) return;
    try {
      await api.deleteEntry(entry.id);
      onDeleted();
    } catch (err) {
      setStatus(describeError(err));
    }
  };

  return (
    <article className="entry">
      <header className="entry-head">
        <select
          className="entry-kind"
          value={entry.kind}
          disabled={offline}
          aria-label="Kind"
          onChange={(e) => void save({ kind: e.target.value as BibleKind })}
        >
          {BIBLE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_ONE[k]}
            </option>
          ))}
        </select>
        <span className="entry-status" aria-live="polite">
          {status === "saved" ? "Saved" : status === "saving" ? "Saving" : status === "editing" ? "Editing" : status}
        </span>
        <span className="desk-spacer" />
        <button className="btn btn-quiet" onClick={remove} disabled={offline}>
          Delete
        </button>
      </header>

      <input
        className="entry-name"
        value={name}
        readOnly={offline}
        aria-label="Name"
        maxLength={120}
        onChange={(e) => setName(e.target.value.replace(/[[\]|]/g, ""))}
        onBlur={commitName}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <label className="entry-aliases">
        Also called
        <input
          value={aliases}
          readOnly={offline}
          placeholder="Other names, separated by commas"
          onChange={(e) => setAliases(e.target.value.replace(/[[\]|]/g, ""))}
          onBlur={commitAliases}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </label>
      <p className="entry-hint">
        Link to this entry from a chapter with <code>[[{entry.name}]]</code>
        {entry.aliases[0] ? (
          <>
            {" "}or <code>[[{entry.aliases[0]}]]</code>
          </>
        ) : null}
        .
      </p>

      <textarea
        className="entry-body"
        value={body}
        readOnly={offline}
        aria-label="Notes"
        placeholder={
          entry.kind === "character"
            ? "Appearance, age, voice, what they want, what they're hiding…"
            : entry.kind === "place"
              ? "What it looks like, smells like, who's there, how far from where…"
              : "Everything worth remembering about this."
        }
        onChange={(e) => {
          setBody(e.target.value);
          setStatus("editing");
          window.clearTimeout(timer.current);
          const text = e.target.value;
          timer.current = window.setTimeout(() => void save({ body: text }), SAVE_DELAY);
        }}
      />

      <Mentions entry={entry} chapters={chapters} onOpenChapter={onOpenChapter} />
    </article>
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Mention {
  chapter: ChapterMeta;
  links: number;
  plain: number;
}

/** Chapters that link to the entry, and those that name it without a link. */
function Mentions({ entry, chapters, onOpenChapter }: { entry: BibleEntry; chapters: ChapterMeta[]; onOpenChapter: (id: string) => void }) {
  const [found, setFound] = useState<Mention[] | null>(null);
  const [missing, setMissing] = useState(0);
  const names = [entry.name, ...entry.aliases];
  const key = names.join("\n");

  useEffect(() => {
    let live = true;
    setFound(null);
    const wanted = new Set(names.map(linkKey));
    const plainRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...names].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu");
    void (async () => {
      const out: Mention[] = [];
      let unavailable = 0;
      for (const c of chapters) {
        const text = await chapterText(c.id);
        if (text === null) {
          unavailable++;
          continue;
        }
        const links = findLinks(text).filter((l) => wanted.has(linkKey(l.name))).length;
        // Plain mentions: the name in running text, outside any [[link]].
        const prose = stripLinks(text.replace(/\[\[[^[\]\n]*\]\]/g, " "));
        const plain = prose.match(plainRe)?.length ?? 0;
        if (links || plain) out.push({ chapter: c, links, plain });
      }
      if (live) {
        setFound(out);
        setMissing(unavailable);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, chapters]);

  return (
    <section className="mentions" aria-label="Mentioned in">
      <h3>Mentioned in</h3>
      {!found && <p className="bible-note">Looking through the chapters…</p>}
      {found && found.length === 0 && <p className="bible-note">No chapter mentions {entry.name} yet.</p>}
      {found && found.length > 0 && (
        <ul>
          {found.map((m) => (
            <li key={m.chapter.id}>
              <button className="mention" onClick={() => onOpenChapter(m.chapter.id)}>
                <span className="mention-title">{m.chapter.title}</span>
                <span className="mention-count">
                  {[
                    m.links ? `${m.links} ${m.links === 1 ? "link" : "links"}` : "",
                    m.plain ? `${m.plain} unlinked` : "",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {missing > 0 && (
        <p className="bible-note">
          {missing} {missing === 1 ? "chapter isn't" : "chapters aren't"} on this device yet, so {missing === 1 ? "it wasn't" : "they weren't"} searched.
        </p>
      )}
    </section>
  );
}
