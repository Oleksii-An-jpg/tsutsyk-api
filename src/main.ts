import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody keeps the untouched request bytes around, which the monobank
  // webhook needs: its signature covers exactly what was sent, and a
  // re-serialised body would never verify.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({
    origin: [
      'http://localhost:3000',
      'https://localhost:3000',
      'https://tsutsyk-client--tsutsyk-live.europe-west4.hosted.app',
      'https://tsutsyk.live',
    ],
    credentials: true,
  });
  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on port ${port}`);
}
bootstrap();
