import { getStyleProfile } from "./style-memory";
import { getTopic } from "./topics";
import { getProject } from "./repo";

/**
 * 阶段上下文。
 *
 * 跑一个阶段需要三样额外的东西：这条稿子的专题规则、作者的风格画像、以及稿件本身。
 * 把它们聚在一起取，接口层就不用各自去拼了。
 */

export type StageContext = {
  projectId: string;
  topicId: string;
  topicName: string;
  topicRules: string;
  styleProfile: string;
  /** 专题声明的正文阶段技能包。 */
  skills: string[];
};

export async function loadStageContext(projectId: string): Promise<StageContext | null> {
  const project = getProject(projectId);
  if (!project) return null;

  const topic = await getTopic(project.topic_id);
  const styleProfile = await getStyleProfile(project.topic_id);

  return {
    projectId,
    topicId: project.topic_id,
    topicName: topic?.name ?? project.topic_id,
    topicRules: topic?.rules ?? "",
    styleProfile,
    skills: topic?.skills ?? [],
  };
}
