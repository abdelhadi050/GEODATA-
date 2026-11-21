"use client";

/**
 * GEODATA HUB — sample create / edit dialog (M4).
 * Depth-interval and parent-borehole rules are enforced server-side;
 * the form mirrors them for instant feedback.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Plus, Pencil } from "lucide-react";
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
import { apiPatch, apiPost } from "@/lib/api-client";
import {
  SAMPLE_TYPES,
  SAMPLE_TYPE_LABELS,
  LAB_STATUSES,
  LAB_STATUS_LABELS,
} from "@/lib/constants";
import { handleFormError, fieldSetter, validateWithSchema, FieldError } from "@/components/projects/project-form-dialog";
import type { SampleListItem } from "@/lib/api-types";

const numberField = (schema: z.ZodType<number>) =>
  z.preprocess(
    (v) => (v === "" || v === null ? undefined : Number(v)),
    z.union([schema, z.undefined()]),
  );

const formSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(2, "2–24 characters")
      .max(24)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Must start with a letter or digit"),
    type: z.enum(SAMPLE_TYPES),
    depthFrom: numberField(z.number().min(0).max(300)),
    depthTo: numberField(z.number().min(0).max(300)),
    recovery: numberField(z.number().min(0).max(100)),
    labStatus: z.enum(LAB_STATUSES),
    collectedAt: z.string().optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine(
    (d) => d.depthTo === undefined || d.depthFrom === undefined || d.depthTo > d.depthFrom,
    { message: "depthTo must be greater than depthFrom", path: ["depthTo"] },
  );

type FormValues = z.input<typeof formSchema>;

export function SampleFormDialog({
  boreholeId,
  boreholeCode,
  layers = [],
  sample,
  variant = "create",
}: {
  boreholeId: string;
  boreholeCode: string;
  layers?: { id: string; label: string }[];
  sample?: SampleListItem;
  variant?: "create" | "edit";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: sample
      ? {
          code: sample.code,
          type: sample.type as FormValues["type"],
          depthFrom: sample.depthFrom ?? "",
          depthTo: sample.depthTo ?? "",
          recovery: sample.recovery ?? "",
          labStatus: sample.labStatus as FormValues["labStatus"],
          collectedAt: sample.collectedAt ? sample.collectedAt.slice(0, 10) : "",
          notes: sample.notes ?? "",
        }
      : {
          code: "",
          type: "DISTURBED",
          depthFrom: "",
          depthTo: "",
          recovery: "",
          labStatus: "NOT_SENT",
          collectedAt: "",
          notes: "",
        },
  });

  async function onSubmit(values: FormValues) {
    if (!validateWithSchema(formSchema, values, fieldSetter(setError))) return;
    setSubmitting(true);
    try {
      const payload = {
        ...(variant === "create" ? { boreholeId } : {}),
        code: values.code,
        type: values.type,
        depthFrom: Number(values.depthFrom),
        depthTo: Number(values.depthTo),
        recovery: values.recovery === "" || values.recovery == null ? undefined : Number(values.recovery),
        labStatus: values.labStatus,
        collectedAt: values.collectedAt || undefined,
        notes: values.notes || undefined,
      };
      if (variant === "create") {
        await apiPost("/api/samples", payload);
        toast({ title: "Sample created", description: `${values.code} in ${boreholeCode}` });
      } else if (sample) {
        await apiPatch(`/api/samples/${sample.id}`, payload);
        toast({ title: "Sample updated", description: sample.code });
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      handleFormError(e, fieldSetter(setError), "Sample could not be saved");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {variant === "create" ? (
          <Button size="sm" variant="outline">
            <Plus className="h-4 w-4" /> New sample
          </Button>
        ) : (
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Edit sample ${sample?.code}`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {variant === "create" ? `New sample — ${boreholeCode}` : `Edit sample ${sample?.code}`}
          </DialogTitle>
          <DialogDescription>
            The depth interval must lie within the borehole and must not overlap
            another sample of the same type with identical bounds.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sample-code">Code</Label>
              <Input id="sample-code" placeholder="S-01" className="font-mono" {...register("code")} />
              <FieldError message={errors.code?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sample-type">Type</Label>
              <Select
                defaultValue={sample?.type ?? "DISTURBED"}
                onValueChange={(v) => setValue("type", v as FormValues["type"])}
              >
                <SelectTrigger id="sample-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SAMPLE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {SAMPLE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="sample-from">Depth from (m) *</Label>
              <Input id="sample-from" type="number" step="any" placeholder="1.00" {...register("depthFrom")} />
              <FieldError message={errors.depthFrom?.message as string | undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sample-to">Depth to (m) *</Label>
              <Input id="sample-to" type="number" step="any" placeholder="1.50" {...register("depthTo")} />
              <FieldError message={errors.depthTo?.message as string | undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sample-recovery">Recovery (%)</Label>
              <Input id="sample-recovery" type="number" step="any" placeholder="optional" {...register("recovery")} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sample-labstatus">Laboratory status</Label>
              <Select
                defaultValue={sample?.labStatus ?? "NOT_SENT"}
                onValueChange={(v) => setValue("labStatus", v as FormValues["labStatus"])}
              >
                <SelectTrigger id="sample-labstatus" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LAB_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {LAB_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sample-collected">Collected on</Label>
              <Input id="sample-collected" type="date" {...register("collectedAt")} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sample-notes">Notes</Label>
            <Textarea id="sample-notes" rows={2} placeholder="Field observations (optional)" {...register("notes")} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : variant === "create" ? "Create sample" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
