import { useEffect, useState } from "react";

export interface Route {
  projectId?: string;
  chapterId?: string;
  shareToken?: string;
  changelog?: boolean;
}

export function parseRoute(pathname: string, hash: string): Route {
  const share = pathname.match(/^\/share\/([^/]+)\/?$/);
  if (share) return { shareToken: decodeURIComponent(share[1]) };
  if (/^#\/changelog\/?$/.test(hash)) return { changelog: true };
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
  const currentRoute = () => parseRoute(window.location.pathname, window.location.hash);
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
