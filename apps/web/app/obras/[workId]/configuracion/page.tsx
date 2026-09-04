import { WorkWorkspace } from '@/components/work-workspace';

export default async function SettingsPage({ params }: { params: Promise<{ workId: string }> }) {
  const { workId } = await params;
  return <WorkWorkspace workId={workId} tab="configuracion" />;
}
