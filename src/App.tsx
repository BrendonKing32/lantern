import { useRoute } from "./router";
import { ProjectList } from "./components/ProjectList";
import { ProjectView } from "./components/ProjectView";
import { PublicShareView } from "./components/PublicShareView";
import { SyncNotice } from "./components/SyncNotice";

export function App() {
  const { projectId, chapterId, shareToken } = useRoute();
  if (shareToken) return <PublicShareView token={shareToken} />;
  return (
    <>
      {projectId ? <ProjectView key={projectId} projectId={projectId} chapterId={chapterId} /> : <ProjectList />}
      <SyncNotice />
    </>
  );
}
