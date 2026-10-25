import { useRoute } from "./router";
import { ProjectList } from "./components/ProjectList";
import { ProjectView } from "./components/ProjectView";

export function App() {
  const { projectId, chapterId } = useRoute();
  return projectId ? (
    <ProjectView key={projectId} projectId={projectId} chapterId={chapterId} />
  ) : (
    <ProjectList />
  );
}
