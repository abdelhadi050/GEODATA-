"use client";

/**
 * GEODATA HUB — laboratory test registration dialog (M4).
 * Registers a test of one of the 12 registry types on a sample.
 * One test per (sample, testType) — duplicates are rejected by the API (409).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { Plus } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiPost } from "@/lib/api-client";
import { handleFormError } from "@/components/projects/project-form-dialog";
import type { RegistryEntryDto } from "@/lib/api-types";

const CATEGORY_LABELS: Record<string, string> = {
  INDEX_PROPERTIES: "Index properties",
  COMPACTION: "Compaction",
  MECHANICAL: "Mechanical",
  IN_SITU: "In situ",
};

export function TestFormDialog({
  sampleId,
  sampleCode,
  registry,
  existingTypes = [],
}: {
  sampleId: string;
  sampleCode: string;
  registry: Pick<RegistryEntryDto, "code" | "label" | "category" | "standard">[];
  existingTypes?: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testType, setTestType] = useState<string>("");

  const available = registry.filter((r) => !existingTypes.includes(r.code));

  async function onSubmit() {
    if (!testType) {
      toast({
        title: "Select a test type",
        description: "Choose one of the 12 registry test types.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiPost<{ id: string }>("/api/lab-tests", {
        sampleId,
        testType,
      });
      toast({
        title: "Laboratory test registered",
        description: `${testType} on sample ${sampleCode}`,
      });
      setOpen(false);
      setTestType("");
      router.push(`/lab-tests/${res.data.id}`);
    } catch (e) {
      handleFormError(e, () => undefined, "Test could not be registered");
    } finally {
      setSubmitting(false);
    }
  }

  const categories = Array.from(
    new Set(available.map((r) => r.category)),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={available.length === 0}>
          <Plus className="h-4 w-4" /> Register test
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register laboratory test — {sampleCode}</DialogTitle>
          <DialogDescription>
            Choose a test type from the 12-type registry. Each type can be
            registered once per sample; results are recorded on the test page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="test-type">Test type</Label>
            <Select value={testType || undefined} onValueChange={setTestType}>
              <SelectTrigger id="test-type" className="w-full">
                <SelectValue placeholder="Select a test type" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectGroup key={cat}>
                    <SelectLabel>{CATEGORY_LABELS[cat] ?? cat}</SelectLabel>
                    {available
                      .filter((r) => r.category === cat)
                      .map((r) => (
                        <SelectItem key={r.code} value={r.code}>
                          {r.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            {testType && (
              <p className="text-xs text-muted-foreground">
                {registry.find((r) => r.code === testType)?.standard}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={onSubmit} disabled={submitting || !testType}>
              {submitting ? "Registering…" : "Create test"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
