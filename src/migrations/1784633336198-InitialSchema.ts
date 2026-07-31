import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1784633336198 implements MigrationInterface {
    name = 'InitialSchema1784633336198'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`features\` (\`id\` varchar(100) NOT NULL, \`title\` varchar(200) NOT NULL, \`deprecated\` tinyint NOT NULL DEFAULT 0, \`sellable\` tinyint NOT NULL DEFAULT 1, PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`packages\` (\`id\` varchar(36) NOT NULL, \`name\` varchar(120) NOT NULL, \`description\` varchar(500) NOT NULL DEFAULT '', \`priceCents\` int NOT NULL DEFAULT '0', \`currency\` varchar(8) NOT NULL DEFAULT 'USD', \`billingInterval\` varchar(16) NOT NULL DEFAULT 'once', \`domainBound\` tinyint NOT NULL DEFAULT 1, \`licenseTtlSeconds\` int NOT NULL DEFAULT '2592000', \`active\` tinyint NOT NULL DEFAULT 1, \`publiclyListed\` tinyint NOT NULL DEFAULT 0, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`customers\` (\`id\` varchar(36) NOT NULL, \`name\` varchar(200) NOT NULL, \`email\` varchar(200) NOT NULL, \`domains\` text NOT NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_8536b8b85c06969f84f0c098b0\` (\`email\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`licenses\` (\`id\` varchar(36) NOT NULL, \`licId\` varchar(64) NOT NULL, \`planName\` varchar(120) NOT NULL DEFAULT '', \`planPriceCents\` int NOT NULL DEFAULT '0', \`planCurrency\` varchar(8) NOT NULL DEFAULT 'USD', \`features\` text NOT NULL, \`domains\` text NOT NULL, \`status\` varchar(16) NOT NULL DEFAULT 'active', \`token\` text NOT NULL, \`kid\` varchar(64) NOT NULL, \`issuedAt\` int NOT NULL, \`expiresAt\` int NOT NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`customerId\` varchar(36) NULL, \`packageId\` varchar(36) NULL, UNIQUE INDEX \`IDX_297c28f85acdab3405d6eb16f7\` (\`licId\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`processed_stripe_events\` (\`eventId\` varchar(200) NOT NULL, \`type\` varchar(80) NOT NULL DEFAULT '', \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`eventId\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`orders\` (\`id\` varchar(36) NOT NULL, \`stripeSessionId\` varchar(200) NOT NULL, \`stripeEventId\` varchar(200) NOT NULL DEFAULT '', \`packageName\` varchar(120) NOT NULL DEFAULT '', \`amountCents\` int NOT NULL DEFAULT '0', \`currency\` varchar(8) NOT NULL DEFAULT 'USD', \`featureIds\` text NOT NULL, \`domainBound\` tinyint NOT NULL DEFAULT 1, \`licenseTtlSeconds\` int NOT NULL DEFAULT 0, \`customerEmail\` varchar(200) NOT NULL, \`customerName\` varchar(200) NOT NULL DEFAULT '', \`domains\` text NOT NULL, \`status\` varchar(16) NOT NULL DEFAULT 'pending', \`licenseDelivered\` tinyint NOT NULL DEFAULT 0, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`packageId\` varchar(36) NULL, \`licenseId\` varchar(36) NULL, UNIQUE INDEX \`IDX_178e0a88de0a59d8afc1d093db\` (\`stripeSessionId\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`permissions\` (\`key\` varchar(100) NOT NULL, \`description\` varchar(200) NOT NULL DEFAULT '', PRIMARY KEY (\`key\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`users\` (\`id\` varchar(36) NOT NULL, \`email\` varchar(200) NOT NULL, \`name\` varchar(120) NOT NULL DEFAULT '', \`passwordHash\` varchar(100) NOT NULL, \`active\` tinyint NOT NULL DEFAULT 1, \`tokenVersion\` int NOT NULL DEFAULT '0', \`refreshTokenId\` varchar(64) NOT NULL DEFAULT '', \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_97672ac88f789774dd47f7c8be\` (\`email\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`roles\` (\`id\` varchar(36) NOT NULL, \`name\` varchar(60) NOT NULL, \`description\` varchar(200) NOT NULL DEFAULT '', \`system\` tinyint NOT NULL DEFAULT 0, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_648e3f5447f725579d7d4ffdfb\` (\`name\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`package_features\` (\`packagesId\` varchar(36) NOT NULL, \`featuresId\` varchar(100) NOT NULL, INDEX \`IDX_8f23d9b8f10bb7f5f6a72bcfe5\` (\`packagesId\`), INDEX \`IDX_04cc7465abbc7380760a83ea1f\` (\`featuresId\`), PRIMARY KEY (\`packagesId\`, \`featuresId\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`user_roles\` (\`usersId\` varchar(36) NOT NULL, \`rolesId\` varchar(36) NOT NULL, INDEX \`IDX_99b019339f52c63ae615358738\` (\`usersId\`), INDEX \`IDX_13380e7efec83468d73fc37938\` (\`rolesId\`), PRIMARY KEY (\`usersId\`, \`rolesId\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`role_permissions\` (\`rolesId\` varchar(36) NOT NULL, \`permissionsKey\` varchar(100) NOT NULL, INDEX \`IDX_0cb93c5877d37e954e2aa59e52\` (\`rolesId\`), INDEX \`IDX_f83bf8eacc537bf21ce4ef2ff1\` (\`permissionsKey\`), PRIMARY KEY (\`rolesId\`, \`permissionsKey\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`licenses\` ADD CONSTRAINT \`FK_a35204be47b56d4007d640c75cf\` FOREIGN KEY (\`customerId\`) REFERENCES \`customers\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`licenses\` ADD CONSTRAINT \`FK_e21a91aee94f2814b9d0434a775\` FOREIGN KEY (\`packageId\`) REFERENCES \`packages\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`orders\` ADD CONSTRAINT \`FK_cfa5a4ae37d5e487d626ccc99b3\` FOREIGN KEY (\`packageId\`) REFERENCES \`packages\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`orders\` ADD CONSTRAINT \`FK_4e734ea971adad2c98cc7f10fca\` FOREIGN KEY (\`licenseId\`) REFERENCES \`licenses\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`package_features\` ADD CONSTRAINT \`FK_8f23d9b8f10bb7f5f6a72bcfe58\` FOREIGN KEY (\`packagesId\`) REFERENCES \`packages\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`package_features\` ADD CONSTRAINT \`FK_04cc7465abbc7380760a83ea1f7\` FOREIGN KEY (\`featuresId\`) REFERENCES \`features\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`user_roles\` ADD CONSTRAINT \`FK_99b019339f52c63ae6153587380\` FOREIGN KEY (\`usersId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`user_roles\` ADD CONSTRAINT \`FK_13380e7efec83468d73fc37938e\` FOREIGN KEY (\`rolesId\`) REFERENCES \`roles\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`role_permissions\` ADD CONSTRAINT \`FK_0cb93c5877d37e954e2aa59e52c\` FOREIGN KEY (\`rolesId\`) REFERENCES \`roles\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`role_permissions\` ADD CONSTRAINT \`FK_f83bf8eacc537bf21ce4ef2ff1d\` FOREIGN KEY (\`permissionsKey\`) REFERENCES \`permissions\`(\`key\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`role_permissions\` DROP FOREIGN KEY \`FK_f83bf8eacc537bf21ce4ef2ff1d\``);
        await queryRunner.query(`ALTER TABLE \`role_permissions\` DROP FOREIGN KEY \`FK_0cb93c5877d37e954e2aa59e52c\``);
        await queryRunner.query(`ALTER TABLE \`user_roles\` DROP FOREIGN KEY \`FK_13380e7efec83468d73fc37938e\``);
        await queryRunner.query(`ALTER TABLE \`user_roles\` DROP FOREIGN KEY \`FK_99b019339f52c63ae6153587380\``);
        await queryRunner.query(`ALTER TABLE \`package_features\` DROP FOREIGN KEY \`FK_04cc7465abbc7380760a83ea1f7\``);
        await queryRunner.query(`ALTER TABLE \`package_features\` DROP FOREIGN KEY \`FK_8f23d9b8f10bb7f5f6a72bcfe58\``);
        await queryRunner.query(`ALTER TABLE \`orders\` DROP FOREIGN KEY \`FK_4e734ea971adad2c98cc7f10fca\``);
        await queryRunner.query(`ALTER TABLE \`orders\` DROP FOREIGN KEY \`FK_cfa5a4ae37d5e487d626ccc99b3\``);
        await queryRunner.query(`ALTER TABLE \`licenses\` DROP FOREIGN KEY \`FK_e21a91aee94f2814b9d0434a775\``);
        await queryRunner.query(`ALTER TABLE \`licenses\` DROP FOREIGN KEY \`FK_a35204be47b56d4007d640c75cf\``);
        await queryRunner.query(`DROP INDEX \`IDX_f83bf8eacc537bf21ce4ef2ff1\` ON \`role_permissions\``);
        await queryRunner.query(`DROP INDEX \`IDX_0cb93c5877d37e954e2aa59e52\` ON \`role_permissions\``);
        await queryRunner.query(`DROP TABLE \`role_permissions\``);
        await queryRunner.query(`DROP INDEX \`IDX_13380e7efec83468d73fc37938\` ON \`user_roles\``);
        await queryRunner.query(`DROP INDEX \`IDX_99b019339f52c63ae615358738\` ON \`user_roles\``);
        await queryRunner.query(`DROP TABLE \`user_roles\``);
        await queryRunner.query(`DROP INDEX \`IDX_04cc7465abbc7380760a83ea1f\` ON \`package_features\``);
        await queryRunner.query(`DROP INDEX \`IDX_8f23d9b8f10bb7f5f6a72bcfe5\` ON \`package_features\``);
        await queryRunner.query(`DROP TABLE \`package_features\``);
        await queryRunner.query(`DROP INDEX \`IDX_648e3f5447f725579d7d4ffdfb\` ON \`roles\``);
        await queryRunner.query(`DROP TABLE \`roles\``);
        await queryRunner.query(`DROP INDEX \`IDX_97672ac88f789774dd47f7c8be\` ON \`users\``);
        await queryRunner.query(`DROP TABLE \`users\``);
        await queryRunner.query(`DROP TABLE \`permissions\``);
        await queryRunner.query(`DROP INDEX \`IDX_178e0a88de0a59d8afc1d093db\` ON \`orders\``);
        await queryRunner.query(`DROP TABLE \`orders\``);
        await queryRunner.query(`DROP TABLE \`processed_stripe_events\``);
        await queryRunner.query(`DROP INDEX \`IDX_297c28f85acdab3405d6eb16f7\` ON \`licenses\``);
        await queryRunner.query(`DROP TABLE \`licenses\``);
        await queryRunner.query(`DROP INDEX \`IDX_8536b8b85c06969f84f0c098b0\` ON \`customers\``);
        await queryRunner.query(`DROP TABLE \`customers\``);
        await queryRunner.query(`DROP TABLE \`packages\``);
        await queryRunner.query(`DROP TABLE \`features\``);
    }

}
