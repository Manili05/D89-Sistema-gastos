import { SupplierDetail } from '@/components/supplier-detail';

export default async function SupplierPage({
  params,
}: {
  params: Promise<{ supplierId: string }>;
}) {
  const { supplierId } = await params;
  return <SupplierDetail supplierId={supplierId} />;
}
