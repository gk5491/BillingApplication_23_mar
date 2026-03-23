import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { inventoryAdjustmentsApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { StatusBadge } from "@/components/StatusBadge";
import { AppPagination } from "@/components/AppPagination";
import { emptyPaginatedResponse } from "@/lib/pagination";

export default function AdjustmentsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);

  const { data: response = emptyPaginatedResponse<any>(), isLoading } = useQuery({
    queryKey: ["inventory_adjustments", page],
    queryFn: () => inventoryAdjustmentsApi.listPage(page),
  });
  const adjustments = response.data;

  const createMut = useMutation({
    mutationFn: () => inventoryAdjustmentsApi.create({ document_number: `ADJ-${Date.now()}`, reason }, []),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["inventory_adjustments"] }); setOpen(false); setReason(""); toast({ title: "Adjustment created" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-foreground">Inventory Adjustments</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" /> New Adjustment</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Adjustment</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <Input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button onClick={() => createMut.mutate()} disabled={!reason} className="w-full">Create</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Number</TableHead><TableHead>Date</TableHead><TableHead>Reason</TableHead><TableHead>Status</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow> :
            adjustments.length === 0 ? <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No adjustments</TableCell></TableRow> :
            adjustments.map((a: any) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.document_number || a.documentNumber}</TableCell>
                <TableCell>{a.date}</TableCell>
                <TableCell className="text-muted-foreground">{a.reason}</TableCell>
                <TableCell><StatusBadge status={a.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <AppPagination currentPage={response.pagination.page} totalPages={response.pagination.totalPages} totalRecords={response.pagination.total} onPageChange={setPage} />
    </div>
  );
}
