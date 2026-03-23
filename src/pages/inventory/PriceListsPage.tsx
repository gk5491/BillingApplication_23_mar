import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { priceListsApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { AppPagination } from "@/components/AppPagination";
import { emptyPaginatedResponse } from "@/lib/pagination";

export default function PriceListsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [page, setPage] = useState(1);

  const { data: response = emptyPaginatedResponse<any>(), isLoading } = useQuery({
    queryKey: ["price_lists", page],
    queryFn: () => priceListsApi.listPage(page),
  });
  const lists = response.data;

  const createMut = useMutation({
    mutationFn: () => priceListsApi.create(form, []),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["price_lists"] }); setOpen(false); toast({ title: "Price list created" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => priceListsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["price_lists"] }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-foreground">Price Lists</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" /> New Price List</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Price List</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <Input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Input placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              <Button onClick={() => createMut.mutate()} disabled={!form.name} className="w-full">Create</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Description</TableHead><TableHead></TableHead></TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow> :
            lists.length === 0 ? <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No price lists</TableCell></TableRow> :
            lists.map((l: any) => (
              <TableRow key={l.id}>
                <TableCell className="font-medium">{l.name}</TableCell>
                <TableCell className="text-muted-foreground">{l.description}</TableCell>
                <TableCell><Button variant="ghost" size="icon" onClick={() => deleteMut.mutate(l.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <AppPagination currentPage={response.pagination.page} totalPages={response.pagination.totalPages} totalRecords={response.pagination.total} onPageChange={setPage} />
    </div>
  );
}
