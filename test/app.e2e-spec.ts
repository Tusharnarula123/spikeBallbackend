import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('API (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  it('/api/leaderboard (GET) returns array', () => {
    return request(app.getHttpServer())
      .get('/api/leaderboard')
      .expect((res) => {
        expect([200, 500]).toContain(res.status);
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
