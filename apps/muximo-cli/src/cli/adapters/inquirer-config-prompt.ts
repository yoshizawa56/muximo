import { checkbox, input, search, select } from "@inquirer/prompts";

export type ConfigPromptChoice = Readonly<{
  value: string;
  label: string;
  description?: string;
  disabled?: boolean | string;
  checked?: boolean;
}>;

export type ConfigPrompt = Readonly<{
  checkbox(options: {
    message: string;
    choices: readonly ConfigPromptChoice[];
    validate?: (values: readonly string[]) => string | true | undefined;
  }): Promise<readonly string[]>;
  select(options: { message: string; choices: readonly ConfigPromptChoice[]; defaultValue?: string }): Promise<string>;
  input(options: {
    message: string;
    defaultValue?: string;
    validate?: (value: string) => string | true | undefined;
  }): Promise<string>;
  search(options: {
    message: string;
    initialValue?: string;
    source: (term: string | undefined) => readonly ConfigPromptChoice[] | Promise<readonly ConfigPromptChoice[]>;
    validate?: (value: string) => string | true | undefined;
  }): Promise<string>;
}>;

export function createInquirerConfigPrompt(
  inputStream: NodeJS.ReadableStream,
  outputStream: NodeJS.WritableStream,
): ConfigPrompt {
  const context = { input: inputStream, output: outputStream };
  return {
    checkbox: async ({ message, choices, validate }) =>
      checkbox(
        {
          message,
          choices: choices.map(toInquirerChoice),
          validate: validate
            ? (selected) => validate(selected.map((choice) => String(choice.value))) ?? true
            : undefined,
        },
        context,
      ),
    select: ({ message, choices, defaultValue }) =>
      select(
        {
          message,
          choices: choices.map(toInquirerChoice),
          ...(defaultValue === undefined ? {} : { default: defaultValue }),
        },
        context,
      ),
    input: ({ message, defaultValue, validate }) =>
      input(
        {
          message,
          ...(defaultValue === undefined ? {} : { default: defaultValue }),
          validate: validate ? (value) => validate(value) ?? true : undefined,
        },
        context,
      ),
    search: ({ message, initialValue, source, validate }) =>
      search(
        {
          message,
          ...(initialValue === undefined ? {} : { initialValue }),
          source: async (term) => (await source(term)).map(toInquirerChoice),
          validate: validate ? (value) => validate(value) ?? true : undefined,
        },
        context,
      ),
  };
}

function toInquirerChoice(choice: ConfigPromptChoice): {
  value: string;
  name: string;
  description?: string;
  disabled?: boolean | string;
  checked?: boolean;
} {
  return {
    value: choice.value,
    name: choice.label,
    ...(choice.description === undefined ? {} : { description: choice.description }),
    ...(choice.disabled === undefined ? {} : { disabled: choice.disabled }),
    ...(choice.checked === undefined ? {} : { checked: choice.checked }),
  };
}
