import { Controller, Get, Header } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  @Header("Content-Type", "text/plain")
  check(): string {
    return "ok\n";
  }
}
