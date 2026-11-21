"use client";

/**
 * GEODATA HUB — borehole create / edit dialog (M4).
 * Same pattern as the project dialog: mirrored client-side rules,
 * authoritative API validation, envelope field errors mapped onto inputs.
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
  BOREHOLE_TYPES,
  BOREHOLE_TYPE_LABELS,
  BOREHOLE_STATUSES,
  BOREHOLE_STATUS_LABELS,
} from "@/lib/constants";
import { handleFormError, fieldSetter, validateWithSchema, FieldError } from "@/components/projects/project-form-dialog";
import type { BoreholeListItem } from "@/lib/api-types";

const numberField = (schema: z.ZodType<number>) =>
  z.preprocess(
    (v) => (v === "" || v === null ? undefined : Number(v)),
    z.union([schema, z.undefined()]),
  );

const formSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "2–24 characters")
    .max(24)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Must start with a letter or digit"),
  type: z.enum(BOREHOLE_TYPES),
  latitude: numberField(z.number().min(-90, "−90…90").max(90, "−90…90")),
  longitude: numberField(z.number().min(-180, "−180…180").max(180, "−180…180")),
  elevation: numberField(z.number().min(-500).max(4500)),
  depth: numberField(z.number().min(0, "≥ 0").max(300, "≤ 300")),
  drillingDate: z.string().optional(),
  drilledBy: z.string().trim().max(120).optional(),
  status: z.enum(BOREHOLE_STATUSES),
  notes: z.string().trim().max(2000).optional(),
});

type FormValues = z.input<typeof formSchema>;

export function BoreholeFormDialog({
  projectId,
  projectCode,
  borehole,
  variant = "create",
}: {
  projectId: string;
  projectCode: string;
  borehole?: BoreholeListItem;
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
    defaultValues: borehole
      ? {
          code: borehole.code,
          type: borehole.type as FormValues["type"],
          latitude: borehole.latitude ?? "",
          longitude: borehole.longitude ?? "",
          elevation: borehole.elevation ?? "",
          depth: borehole.depth ?? "",
          drillingDate: borehole.drillingDate ? borehole.drillingDate.slice(0, 10) : "",
          drilledBy: borehole.drilledBy ?? "",
          status: borehole.status as FormValues["status"],
          notes: borehole.notes ?? "",
        }
      : {
          code: "",
          type: "ROTARY_CORE",
          latitude: "",
          longitude: "",
          elevation: "",
          depth: "",
          drillingDate: "",
          drilledBy: "",
          status: "PLANNED",
          notes: "",
        },
  });

  async function onSubmit(values: FormValues) {
    if (!validateWithSchema(formSchema, values, fieldSetter(setError))) return;
    setSubmitting(true);
    try {
      const payload = {
        ...(variant === "create" ? { projectId } : {}),
        code: values.code,
        type: values.type,
        latitude: Number(values.latitude),
        longitude: Number(values.longitude),
        elevation: values.elevation === "" || values.elevation == null ? undefined : Number(values.elevation),
        depth: values.depth === "" || values.depth == null ? undefined : Number(values.depth),
        drillingDate: values.drillingDate || undefined,
        drilledBy: values.drilledBy || undefined,
        status: values.status,
        notes: values.notes || undefined,
      };
      if (variant === "create") {
        const res = await apiPost<{ id: string; code: string }>("/api/boreholes", payload);
        toast({
          title: "Borehole created",
          description: `${res.data.code} in ${projectCode}`,
        });
        setOpen(false);
        router.push(`/boreholes/${res.data.id}`);
      } else if (borehole) {
        await apiPatch(`/api/boreholes/${borehole.id}`, payload);
        toast({ title: "Borehole updated", description: borehole.code });
        setOpen(false);
        router.refresh();
      }
    } catch (e) {
      handleFormError(e, fieldSetter(setError), "Borehole could not be saved");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {variant === "create" ? (
          <Button size="sm">
            <Plus className="h-4 w-4" /> New borehole
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {variant === "create" ? `New borehole — ${projectCode}` : `Edit ${borehole?.code}`}
          </DialogTitle>
          <DialogDescription>
            {variant === "create"
              ? "Register a borehole, sounding or trial pit under this project."
              : "Update drilling metadata. Coordinates are required."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bh-code">Code</Label>
              <Input id="bh-code" placeholder="BH-01" className="font-mono" {...register("code")} />
              <FieldError message={errors.code?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bh-type">Type</Label>
              <Select
                defaultValue={borehole?.type ?? "ROTARY_CORE"}
                onValueChange={(v) => setValue("type", v as FormValues["type"])}
              >
                <SelectTrigger id="bh-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOREHOLE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {BOREHOLE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bh-lat">Latitude *</Label>
              <Input id="bh-lat" type="number" step="any" placeholder="36.470000" {...register("latitude")} />
              <FieldError message={errors.latitude?.message as string | undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bh-lng">Longitude *</Label>
              <Input id="bh-lng" type="number" step="any" placeholder="2.830000" {...register("longitude")} />
              <FieldError message={errors.longitude?.message as string | undefined} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="bh-elev">Elevation (m)</Label>
              <Input id="bh-elev" type="number" step="any" placeholder="± m" {...register("elevation")} />
              <FieldError message={errors.elevation?.message as string | undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bh-depth">Depth (m)</Label>
              <Input id="bh-depth" type="number" step="any" placeholder="e.g. 20" {...register("depth")} />
              <FieldError message={errors.depth?.message as string | undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bh-date">Drilling date</Label>
              <Input id="bh-date" type="date" {...register("drillingDate")} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bh-status">Status</Label>
              <Select
                defaultValue={borehole?.status ?? "PLANNED"}
                onValueChange={(v) => setValue("status", v as FormValues["status"])}
              >
                <SelectTrigger id="bh-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOREHOLE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {BOREHOLE_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bh-drilledby">Drilled by</Label>
              <Input id="bh-drilledby" placeholder="Contractor (optional)" {...register("drilledBy")} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bh-notes">Notes</Label>
            <Textarea id="bh-notes" rows={2} placeholder="Observations (optional)" {...register("notes")} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : variant === "create" ? "Create borehole" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
