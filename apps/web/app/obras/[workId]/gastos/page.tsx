import { WorkWorkspace } from '@/components/work-workspace';

export default async function ExpensesPage({ params }: { params: Promise<{ workId: string }> }) {
  const { workId } = await params;
  return <WorkWorkspace workId={workId} tab="gastos" />;
}
