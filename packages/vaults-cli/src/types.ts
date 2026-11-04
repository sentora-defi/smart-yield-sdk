export interface OptSpec {
  type: 'string' | 'boolean';
  description: string;
  required?: boolean;
  placeholder?: string;
}

export type Flags = Record<string, string | boolean | undefined>;

export interface CommandDef {
  /** '' for top-level commands like `describe` */
  family: string;
  name: string;
  summary: string;
  options: Record<string, OptSpec>;
  examples: string[];
  run(flags: Flags): Promise<unknown>;
}
