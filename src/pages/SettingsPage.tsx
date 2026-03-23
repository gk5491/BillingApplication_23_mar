import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Building2, Users, Receipt, FileText, ArrowLeft, Trash2, Star, Edit2 } from "lucide-react";
import { adminUsersApi, gstSettingsApi, taxRatesApi, documentSequencesApi, userRolesApi } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Section = null | "organization" | "users" | "taxes" | "invoice";

export default function SettingsPage() {
  const [section, setSection] = useState<Section>(null);

  if (section) {
    return (
      <div>
        <Button variant="ghost" size="sm" className="mb-4" onClick={() => setSection(null)}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Settings
        </Button>
        {section === "organization" && <OrganizationSection />}
        {section === "users" && <UsersSection />}
        {section === "taxes" && <TaxesSection />}
        {section === "invoice" && <InvoiceSettingsSection />}
      </div>
    );
  }

  const sections = [
    { key: "organization" as Section, icon: Building2, label: "Organization", desc: "Company details, GSTIN, address" },
    { key: "users" as Section, icon: Users, label: "Users & Roles", desc: "Manage team and permissions" },
    { key: "taxes" as Section, icon: Receipt, label: "Taxes", desc: "GST slabs and tax configuration" },
    { key: "invoice" as Section, icon: FileText, label: "Invoice Settings", desc: "Document numbering and prefixes" },
  ];

  return (
    <div>
      <PageHeader title="Settings" subtitle="Configure your accounting system" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <button key={s.key} onClick={() => setSection(s.key)} className="bg-card rounded-xl border border-border p-5 text-left hover:shadow-md hover:border-primary/30 transition-all group">
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-lg bg-accent group-hover:bg-primary/10 transition-colors">
                  <Icon className="w-5 h-5 text-accent-foreground group-hover:text-primary transition-colors" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-card-foreground">{s.label}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{s.desc}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ReadOnlyNote() {
  return <p className="text-sm text-muted-foreground mb-4">Only admins can modify settings. You have read-only access.</p>;
}

// ===== Organization =====
function OrganizationSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { userRole } = useAuth();
  const isAdmin = userRole === "admin";
  const { data: gst, isLoading } = useQuery({ queryKey: ["gst_settings"], queryFn: gstSettingsApi.get });
  const [form, setForm] = useState<any>(null);

  const currentForm = form || gst || {};
  const updateField = (field: string, value: any) => setForm({ ...currentForm, [field]: value });

  const saveMutation = useMutation({
    mutationFn: (data: any) => gstSettingsApi.upsert(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gst_settings"] });
      toast({ title: "Settings saved" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="text-center text-muted-foreground py-12">Loading...</div>;

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground mb-4 font-display">Organization Settings</h2>
      {!isAdmin && <ReadOnlyNote />}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4 max-w-lg">
        <div className="space-y-2"><Label>Legal Name</Label><Input value={currentForm.legal_name || ""} onChange={e => updateField("legal_name", e.target.value)} disabled={!isAdmin} /></div>
        <div className="space-y-2"><Label>Trade Name</Label><Input value={currentForm.trade_name || ""} onChange={e => updateField("trade_name", e.target.value)} disabled={!isAdmin} /></div>
        <div className="space-y-2"><Label>GSTIN</Label><Input value={currentForm.gstin || ""} onChange={e => updateField("gstin", e.target.value)} placeholder="22AAAAA0000A1Z5" disabled={!isAdmin} /></div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2"><Label>State</Label><Input value={currentForm.state || ""} onChange={e => updateField("state", e.target.value)} disabled={!isAdmin} /></div>
          <div className="space-y-2"><Label>State Code</Label><Input value={currentForm.state_code || ""} onChange={e => updateField("state_code", e.target.value)} disabled={!isAdmin} /></div>
        </div>
        <Button onClick={() => saveMutation.mutate(currentForm)} disabled={saveMutation.isPending || !isAdmin}>
          {saveMutation.isPending ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}

// ===== Users =====
function UsersSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user, userRole } = useAuth();
  const isAdmin = userRole === "admin";
  const { data: roles = [], isLoading } = useQuery({ queryKey: ["user_roles"], queryFn: userRolesApi.list });

  const [addOpen, setAddOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [newUser, setNewUser] = useState({
    display_name: "",
    email: "",
    username: "",
    phone: "",
    password: "",
    role: "viewer",
    is_active: true,
  });
  const [editForm, setEditForm] = useState<any>({
    display_name: "",
    email: "",
    username: "",
    phone: "",
    password: "",
    role: "viewer",
    is_active: true,
  });

  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: ["user_roles"] });

  const createUserMutation = useMutation({
    mutationFn: () => adminUsersApi.create(newUser),
    onSuccess: () => {
      refreshUsers();
      setAddOpen(false);
      setNewUser({ display_name: "", email: "", username: "", phone: "", password: "", role: "viewer", is_active: true });
      toast({ title: "User created" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => adminUsersApi.update(id, payload),
    onSuccess: () => {
      refreshUsers();
      setEditingUser(null);
      toast({ title: "User updated" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteUserMutation = useMutation({
    mutationFn: (id: string) => adminUsersApi.delete(id),
    onSuccess: () => {
      refreshUsers();
      toast({ title: "User deleted" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleEditOpen = (record: any) => {
    setEditingUser(record);
    setEditForm({
      display_name: record.display_name || "",
      email: record.email || "",
      username: record.username || "",
      phone: record.phone || "",
      password: "",
      role: record.role || "viewer",
      is_active: record.is_active !== false,
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground font-display">Users & Roles</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isAdmin ? "Admins can add, edit, and delete users." : "Only admins can add, edit, and delete users."}
          </p>
        </div>
        {isAdmin && <Button size="sm" onClick={() => setAddOpen(true)}>Add User</Button>}
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground">Loading...</div>
        ) : roles.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">No users found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/40">
              <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">User</th>
              <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Email</th>
              <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Role</th>
              <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
            </tr></thead>
            <tbody>
              {roles.map((r: any) => (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-5 py-2.5 text-card-foreground">{r.display_name || r.username || r.email || "-"}</td>
                  <td className="px-5 py-2.5 text-muted-foreground">{r.email || "-"}</td>
                  <td className="px-5 py-2.5 text-card-foreground capitalize">{r.role || "viewer"}</td>
                  <td className="px-5 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${r.is_active === false ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600"}`}>
                      {r.is_active === false ? "Inactive" : "Active"}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {isAdmin ? (
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleEditOpen(r)}>
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={r.user_id === user?.id || deleteUserMutation.isPending}
                          onClick={() => {
                            if (confirm("Delete this user? This will deactivate their account.")) {
                              deleteUserMutation.mutate(r.user_id);
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Admin only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>Create a new user account and assign a role.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Display Name</Label><Input value={newUser.display_name} onChange={(e) => setNewUser({ ...newUser, display_name: e.target.value })} /></div>
            <div className="space-y-2"><Label>Email</Label><Input type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></div>
            <div className="space-y-2"><Label>Username</Label><Input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></div>
            <div className="space-y-2"><Label>Phone</Label><Input value={newUser.phone} onChange={(e) => setNewUser({ ...newUser, phone: e.target.value })} /></div>
            <div className="space-y-2"><Label>Password</Label><Input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={newUser.role} onValueChange={(value) => setNewUser({ ...newUser, role: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="staff">Staff</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={newUser.is_active ? "true" : "false"} onValueChange={(value) => setNewUser({ ...newUser, is_active: value === "true" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Active</SelectItem>
                    <SelectItem value="false">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button className="w-full" onClick={() => createUserMutation.mutate()} disabled={!newUser.email || !newUser.password || createUserMutation.isPending}>
              {createUserMutation.isPending ? "Creating..." : "Create User"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingUser} onOpenChange={(open) => { if (!open) setEditingUser(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>Update user details, role, and account status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Display Name</Label><Input value={editForm.display_name || ""} onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })} /></div>
            <div className="space-y-2"><Label>Email</Label><Input type="email" value={editForm.email || ""} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} /></div>
            <div className="space-y-2"><Label>Username</Label><Input value={editForm.username || ""} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} /></div>
            <div className="space-y-2"><Label>Phone</Label><Input value={editForm.phone || ""} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} /></div>
            <div className="space-y-2"><Label>New Password</Label><Input type="password" value={editForm.password || ""} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} placeholder="Leave blank to keep current password" /></div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={editForm.role || "viewer"} onValueChange={(value) => setEditForm({ ...editForm, role: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="staff">Staff</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={editForm.is_active ? "true" : "false"} onValueChange={(value) => setEditForm({ ...editForm, is_active: value === "true" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Active</SelectItem>
                    <SelectItem value="false">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button className="w-full" onClick={() => updateUserMutation.mutate({ id: editingUser.user_id, payload: editForm })} disabled={!editForm.email || updateUserMutation.isPending}>
              {updateUserMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ===== Taxes (Full GST Slab Management) =====
function TaxesSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { userRole } = useAuth();
  const isAdmin = userRole === "admin";
  const { data: taxes = [], isLoading } = useQuery({ queryKey: ["tax_rates"], queryFn: taxRatesApi.list });
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const cgst = Number(rate) / 2;
  const sgst = Number(rate) / 2;
  const igst = Number(rate);

  const createMutation = useMutation({
    mutationFn: () => taxRatesApi.create({
      name: name || `GST ${rate}%`,
      rate: Number(rate),
      tax_type: "GST",
      cgst,
      sgst,
      igst,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tax_rates"] });
      setName("");
      setRate("");
      setShowAdd(false);
      toast({ title: "Tax slab added" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: taxRatesApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tax_rates"] });
      toast({ title: "Tax slab deleted" });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (id: string) => {
      for (const t of taxes) {
        if ((t as any).is_default) {
          await taxRatesApi.update((t as any).id, { is_default: false });
        }
      }
      await taxRatesApi.update(id, { is_default: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tax_rates"] });
      toast({ title: "Default tax slab updated" });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) => taxRatesApi.update(id, { is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tax_rates"] }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-foreground font-display">Tax Rates (GST Slabs)</h2>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)} disabled={!isAdmin}>
          {showAdd ? "Cancel" : "+ Add Tax Slab"}
        </Button>
      </div>

      {!isAdmin && <ReadOnlyNote />}

      {showAdd && (
        <div className="bg-card border border-border rounded-xl p-5 mb-4 max-w-lg">
          <h3 className="text-sm font-semibold text-card-foreground mb-3">New GST Slab</h3>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Slab Name</Label>
              <Input placeholder="e.g. GST 18%" value={name} onChange={e => setName(e.target.value)} disabled={!isAdmin} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Rate (%)</Label>
              <Input placeholder="18" type="number" value={rate} onChange={e => setRate(e.target.value)} disabled={!isAdmin} />
            </div>
          </div>
          {rate && Number(rate) > 0 && (
            <div className="bg-muted/50 rounded-lg p-3 mb-3 text-xs space-y-1">
              <p className="font-medium text-card-foreground">Auto-calculated split:</p>
              <div className="flex gap-4 text-muted-foreground">
                <span>CGST: {cgst}%</span>
                <span>SGST: {sgst}%</span>
                <span>IGST: {igst}%</span>
              </div>
            </div>
          )}
          <Button size="sm" onClick={() => createMutation.mutate()} disabled={!rate || createMutation.isPending || !isAdmin}>
            {createMutation.isPending ? "Adding..." : "Add Slab"}
          </Button>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center">
            <div className="inline-block h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-muted-foreground mt-2">Loading...</p>
          </div>
        ) : taxes.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">No tax slabs configured. Add your first GST slab.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Tax Name</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Rate</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">CGST</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">SGST</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">IGST</th>
                <th className="text-center px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Default</th>
                <th className="text-center px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Active</th>
                <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"></th>
              </tr>
            </thead>
            <tbody>
              {taxes.map((t: any) => (
                <TaxSlabRow
                  key={t.id}
                  tax={t}
                  canEdit={isAdmin}
                  onSetDefault={() => setDefaultMutation.mutate(t.id)}
                  onToggleActive={(active: boolean) => toggleActiveMutation.mutate({ id: t.id, is_active: active })}
                  onDelete={() => { if (confirm("Delete this tax slab?")) deleteMutation.mutate(t.id); }}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function TaxSlabRow({ tax, onSetDefault, onToggleActive, onDelete, canEdit }: {
  tax: any;
  onSetDefault: () => void;
  onToggleActive: (active: boolean) => void;
  onDelete: () => void;
  canEdit: boolean;
}) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
      <td className="px-5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-card-foreground">{tax.name}</span>
          {tax.is_default && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary">
              <Star className="w-2.5 h-2.5" /> Default
            </span>
          )}
        </div>
      </td>
      <td className="px-5 py-2.5 text-right font-medium text-card-foreground">{tax.rate}%</td>
      <td className="px-5 py-2.5 text-right text-muted-foreground">{tax.cgst ?? (tax.rate / 2)}%</td>
      <td className="px-5 py-2.5 text-right text-muted-foreground">{tax.sgst ?? (tax.rate / 2)}%</td>
      <td className="px-5 py-2.5 text-right text-muted-foreground">{tax.igst ?? tax.rate}%</td>
      <td className="px-5 py-2.5 text-center">
        {canEdit && !tax.is_default && (
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-primary" onClick={onSetDefault}>
            Set Default
          </Button>
        )}
      </td>
      <td className="px-5 py-2.5 text-center">
        <Switch checked={tax.is_active} onCheckedChange={onToggleActive} disabled={!canEdit} />
      </td>
      <td className="px-5 py-2.5 text-right">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onDelete} disabled={!canEdit}>
          <Trash2 className="w-3.5 h-3.5 text-destructive" />
        </Button>
      </td>
    </tr>
  );
}

// ===== Invoice Settings =====
function InvoiceSettingsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { userRole } = useAuth();
  const isAdmin = userRole === "admin";
  const { data: sequences = [], isLoading } = useQuery({ queryKey: ["document_sequences"], queryFn: documentSequencesApi.list });

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: any) => documentSequencesApi.update(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document_sequences"] });
      toast({ title: "Sequence updated" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground mb-4 font-display">Document Number Series</h2>
      {!isAdmin && <ReadOnlyNote />}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {isLoading ? <div className="p-8 text-center text-muted-foreground">Loading...</div> : sequences.length === 0 ? <div className="p-8 text-center text-muted-foreground">No sequences configured.</div> : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/40">
              <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Document Type</th>
              <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Prefix</th>
              <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Next #</th>
              <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Padding</th>
              <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"></th>
            </tr></thead>
            <tbody>{sequences.map((s: any) => (
              <SequenceRow key={s.id} seq={s} canEdit={isAdmin} onSave={(id: string, updates: any) => updateMutation.mutate({ id, updates })} />
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SequenceRow({ seq, onSave, canEdit }: { seq: any; onSave: (id: string, updates: any) => void; canEdit: boolean }) {
  const [prefix, setPrefix] = useState(seq.prefix);
  const [nextNum, setNextNum] = useState(seq.next_number);
  const [padding, setPadding] = useState(seq.padding);
  const changed = prefix !== seq.prefix || nextNum !== seq.next_number || padding !== seq.padding;

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-5 py-2.5 text-card-foreground capitalize">{seq.document_type.replace(/_/g, " ")}</td>
      <td className="px-5 py-2"><Input className="h-8 w-24" value={prefix} onChange={e => setPrefix(e.target.value)} disabled={!canEdit} /></td>
      <td className="px-5 py-2"><Input className="h-8 w-20" type="number" value={nextNum} onChange={e => setNextNum(Number(e.target.value))} disabled={!canEdit} /></td>
      <td className="px-5 py-2"><Input className="h-8 w-16" type="number" value={padding} onChange={e => setPadding(Number(e.target.value))} disabled={!canEdit} /></td>
      <td className="px-5 py-2 text-right">
        {canEdit && changed && <Button size="sm" className="h-7 text-xs" onClick={() => onSave(seq.id, { prefix, next_number: nextNum, padding })}>Save</Button>}
      </td>
    </tr>
  );
}
