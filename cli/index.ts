import { Command } from "commander";

const program = new Command();

program
  .name("misconception-cli")
  .description("CLI utilities for Misconception of the Day")
  .version("0.0.1");

program
  .command("hello")
  .description("A simple hello command")
  .argument("[name]", "name to greet", "world")
  .action((name: string) => {
    console.log(`Hello, ${name}!`);
  });

program.parse();
