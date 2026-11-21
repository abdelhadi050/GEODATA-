"use client";

/**
 * GEODATA HUB — sharing request creation / decision / revoke actions (M4).
 * All state transitions go through the M3 sharing endpoints; only requests
 * you are authorized to act on render controls.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, Send, X } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  apiGet,
  apiPost,
  apiDelete,
  ApiClientError,
} from "@/lib/api-client";
import type { ProjectListItem, OrganizationInfo } from "@/lib/api-types";

export function SharingCreateDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [orgs, setOrgs] = useState<OrganizationInfo[]>([]);
  const [projectId, setProjectId] = useState("");
  const [targetOrg, setTargetOrg] = useState("");
  const [message, setMessage] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      apiGet<ProjectListItem[]>("/api/projects?pageSize=100&sortBy=code&sortOrder=asc"),
      apiGet<OrganizationInfo[]>("/api/sharing/organizations"),
    ])
      .then(([p, o]) => {
        setProjects(p.data.filter((x) => !x.sharedWithYou));
        setOrgs(o.data);
      })
      .catch(() => {
        setProjects([]);
        setOrgs([]);
      });
  }, [open]);

  async function onSubmit() {
    setError(null);
    if (!projectId) return setError("Select one of your organization's projects.");
    if (!targetOrg) return setError("Select the target organization.");
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      return setError("Expiry must be in the future.");
    }
    setSubmitting(true);
    try {
      await apiPost("/api/sharing/requests", {
        projectId,
        targetOrganizationId: targetOrg,
        message: message || undefined,
        expiresAt: expiresAt || undefined,
      });
      toast({ title: "Sharing request sent" });
      setOpen(false);
      setProjectId("");
      setTargetOrg("");
      setMessage("");
      setExpiresAt("");
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.status === 401) {
          window.location.href = "/login";
          return;
        }
        setError(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" /> New sharing request
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share a project</DialogTitle>
          <DialogDescription>
            Grants the target organization read-only (VIEW) access to the
            selected project and its data. They must approve before access
            becomes active.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="share-project">Your project *</Label>
            <Select value={projectId || undefined} onValueChange={setProjectId}>
              <SelectTrigger id="share-project" className="w-full">
                <SelectValue placeholder={projects.length === 0 ? "No projects" : "Select project"} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} — {p.name.length > 40 ? `${p.name.slice(0, 40)}…` : p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="share-org">Target organization *</Label>
            <Select value={targetOrg || undefined} onValueChange={setTargetOrg}>
              <SelectTrigger id="share-org" className="w-full">
                <SelectValue placeholder={orgs.length === 0 ? "No partner organizations" : "Select organization"} />
              </SelectTrigger>
              <SelectContent>
                {orgs.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="share-message">Message (optional)</Label>
            <Textarea
              id="share-message"
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Why you are requesting / offering this share"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="share-expiry">Expires on (optional)</Label>
            <Input
              id="share-expiry"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onSubmit} disabled={submitting}>
            {submitting ? "Sending…" : "Send request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SharingDecision({
  requestId,
  projectCode,
}: {
  requestId: string;
  projectCode: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"APPROVE" | "REJECT" | null>(null);

  async function decide(decision: "APPROVE" | "REJECT") {
    setBusy(decision);
    try {
      await apiPost(`/api/sharing/requests/${requestId}/decision`, { decision });
      toast({
        title: decision === "APPROVE" ? "Share approved" : "Share rejected",
        description: projectCode,
      });
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        toast({ title: "Decision failed", description: e.message, variant: "destructive" });
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex justify-end gap-1.5">
      <Button
        size="sm"
        variant="outline"
        onClick={() => decide("APPROVE")}
        disabled={busy !== null}
      >
        <Check className="h-4 w-4" /> Approve
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => decide("REJECT")}
        disabled={busy !== null}
      >
        <X className="h-4 w-4" /> Reject
      </Button>
    </div>
  );
}

export function SharingRevoke({ requestId, projectCode }: { requestId: string; projectCode: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function revoke() {
    if (!window.confirm(`Revoke sharing of ${projectCode}? The partner loses access immediately.`)) {
      return;
    }
    setBusy(true);
    try {
      await apiDelete(`/api/sharing/requests/${requestId}`);
      toast({ title: "Sharing revoked", description: projectCode });
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        toast({ title: "Revoke failed", description: e.message, variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="ghost" className="text-destructive" onClick={revoke} disabled={busy}>
      <Send className="h-4 w-4 rotate-180" /> Revoke
    </Button>
  );
}
