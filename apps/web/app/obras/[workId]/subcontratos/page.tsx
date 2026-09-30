import { WorkWorkspace } from '@/components/work-workspace';

export default async function SubcontractsPage({ params }: { params: Promise<{ workId: string }> }) {
  const { workId } = await params;
  return <WorkWorkspace workId={workId} tab="subcontratos" />;
}
