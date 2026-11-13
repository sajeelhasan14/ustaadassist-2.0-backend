import { z } from "zod";

// A course's grade scale: each grade with the lowest percentage that earns it. Below every band = F.
export type GradeBand = { grade: string; min: number };

// The default for every course: the University of Karachi bands, from the real result sheets.
// Teachers can change it per course (courses.grade_scale); null there means this one.
export const DEFAULT_GRADE_SCALE: GradeBand[] = [
  { grade: "A+", min: 90 },
  { grade: "A", min: 85 },
  { grade: "A-", min: 80 },
  { grade: "B+", min: 75 },
  { grade: "B", min: 71 },
  { grade: "B-", min: 68 },
  { grade: "C+", min: 64 },
  { grade: "C", min: 61 },
  { grade: "C-", min: 57 },
  { grade: "D+", min: 53 },
  { grade: "D", min: 50 },
];

// What a valid scale sent by the app looks like: 1 to 20 bands, names unique, minimums all different.
export const gradeScaleSchema = z
  .array(z.object({ grade: z.string().trim().min(1, "Every band needs a grade.").max(5), min: z.number().min(0).max(100) }))
  .min(1, "Keep at least one grade.")
  .max(20)
  .refine((bands) => new Set(bands.map((band) => band.grade.toUpperCase())).size === bands.length, "Each grade can appear once.")
  .refine((bands) => new Set(bands.map((band) => band.min)).size === bands.length, "Two grades can't start at the same %.")
  // Stored highest first, so the first band a student reaches is their grade.
  .transform((bands) => [...bands].sort((a, b) => b.min - a.min));

// The grade for a percentage on this scale.
export function gradeFor(scale: GradeBand[], percentage: number): string {
  return scale.find((band) => percentage >= band.min)?.grade ?? "F";
}
