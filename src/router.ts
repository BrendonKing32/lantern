import { useEffect, useState } from "react";

export interface Route {
  projectId?: string;
  chapterId?: string;
  shareToken?: string;
}

function parse(hash: string): Route {
  const share = window.location.pathname.match(/^\/share\/([^/]+)\/?$/);
  if (share) return { shareToken: decodeURIComponent(share[1]) };
  const m = hash.match(/^#\/p\/([^/]+)(?:\/([^/]+))?/);
  return m ? { projectId: m[1], chapterId: m[2] } : {};
}

export function navigate(projectId?: string, chapterId?: string, replace = false) {
  const hash = projectId ? `#/p/${projectId}${chapterId ? `/${chapterId}` : ""}` : "#/";
  if (replace) {
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = hash;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
