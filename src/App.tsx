import { useRoute } from "./router";
import { ProjectList } from "./components/ProjectList";
import { ProjectView } from "./components/ProjectView";
import { PublicShareView } from "./components/PublicShareView";
import { Changelog } from "./components/Changelog";
import { SyncNotice } from "./components/SyncNotice";

export function App() {
  const { projectId, chapterId, shareToken, changelog } = useRoute();
  if (shareToken) return <PublicShareView token={shareToken} />;
  return (
    <>
      {changelog ? (
        <Changelog />
      ) : projectId ? (
        <ProjectView key={projectId} projectId={projectId} chapterId={chapterId} />
      ) : (
        <ProjectList />
      )}
      <SyncNotice />
    </>
  );
}
