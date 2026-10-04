import { FolderKanban } from "lucide-react";
import { registerModule } from "@/app/registry";
import { PageContainer } from "@/core/shared/components/Page";
import { EmptyState } from "@/core/shared/components/States";

/** 项目管理（功能级 / 业务模块，阶段二实现） */
export default function ProjectManager() {
  return (
    <PageContainer>
      <EmptyState
        icon={<FolderKanban size={28} strokeWidth={1.5} />}
        title="项目管理模块建设中"
        description="阶段二实现：proj_ 表 + git 命令集成（仓库列表、状态查询、提交后经 event-bus 刷新概览卡片）"
      />
    </PageContainer>
  );
}

registerModule({
  id: "project-manager",
  name: "项目管理",
  description: "代码仓库列表与提交活动",
  icon: FolderKanban,
  component: ProjectManager,
  order: 20,
});
