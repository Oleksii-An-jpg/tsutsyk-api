import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: async () => {
        const client = new SecretManagerServiceClient();
        const name =
          'projects/965875968613/secrets/DATABASE_URL/versions/latest';
        const [version] = await client.accessSecretVersion({ name });
        const secretValue = version.payload.data.toString('utf8');

        // Return a new instance of the service with the secret
        return new PrismaService(
          process.env.NODE_ENV === 'production'
            ? secretValue
            : process.env.DATABASE_URL,
        );
      },
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
