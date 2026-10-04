import { AudioLines } from "lucide-react";
import { registerModule } from "@/app/registry";
import { PageContainer } from "@/core/shared/components/Page";
import { EmptyState } from "@/core/shared/components/States";

/** 音频管理（功能级 / 业务模块，阶段二实现） */
export default function AudioManager() {
  return (
    <PageContainer>
      <EmptyState
        icon={<AudioLines size={28} strokeWidth={1.5} />}
        title="音频管理模块建设中"
        description="阶段二实现：audio_ 表 + ffmpeg sidecar（导入/引用双策略、转码进度经事件推送而非轮询）"
      />
    </PageContainer>
  );
}

registerModule({
  id: "audio-manager",
  name: "音频管理",
  description: "音频文件库与 ffmpeg 转码任务",
  icon: AudioLines,
  component: AudioManager,
  order: 30,
});
