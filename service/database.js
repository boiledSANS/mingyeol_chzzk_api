import mysql from 'mysql2/promise';

const SCHEMA_VERSION = 'shared-account-links-v1';

export async function createDatabase(config) {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  });

  await pool.query('SELECT 1');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_links (
      minecraft_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
      discord_user_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
      discord_username VARCHAR(100) NULL,
      discord_nickname VARCHAR(100) NULL,
      discord_linked_at DATETIME(3) NULL,
      chzzk_channel_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
      chzzk_channel_name VARCHAR(100) NULL,
      chzzk_linked_at DATETIME(3) NULL,
      youtube_channel_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
      youtube_channel_name VARCHAR(100) NULL,
      youtube_linked_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (minecraft_uuid),
      UNIQUE KEY uq_account_links_discord_user_id (discord_user_id),
      UNIQUE KEY uq_account_links_chzzk_channel_id (chzzk_channel_id),
      UNIQUE KEY uq_account_links_youtube_channel_id (youtube_channel_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // CREATE TABLE does not add new fields to an existing installation.
  // MariaDB supports idempotent column/index additions, so upgrades stay automatic.
  await pool.query('ALTER TABLE account_links ADD COLUMN IF NOT EXISTS youtube_channel_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NULL AFTER chzzk_linked_at');
  await pool.query('ALTER TABLE account_links ADD COLUMN IF NOT EXISTS youtube_channel_name VARCHAR(100) NULL AFTER youtube_channel_id');
  await pool.query('ALTER TABLE account_links ADD COLUMN IF NOT EXISTS youtube_linked_at DATETIME(3) NULL AFTER youtube_channel_name');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_account_links_youtube_channel_id ON account_links (youtube_channel_id)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_migrations (
      migration_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
      completed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (migration_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  return new AccountDatabase(pool);
}

class AccountDatabase {
  constructor(pool) {
    this.pool = pool;
  }

  async getAccount(minecraftUuid) {
    const [rows] = await this.pool.execute('SELECT * FROM account_links WHERE minecraft_uuid = ?', [normalizeUuid(minecraftUuid)]);
    return rows.length === 0 ? null : publicAccount(rows[0]);
  }

  async getChzzkLink(minecraftUuid) {
    const [rows] = await this.pool.execute(
      'SELECT minecraft_uuid, chzzk_channel_id, chzzk_channel_name, chzzk_linked_at FROM account_links WHERE minecraft_uuid = ? AND chzzk_channel_id IS NOT NULL',
      [normalizeUuid(minecraftUuid)]
    );
    return rows.length === 0 ? null : publicChzzk(rows[0]);
  }

  async setChzzkLink(minecraftUuid, link) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [owners] = await connection.execute(
        'SELECT minecraft_uuid FROM account_links WHERE chzzk_channel_id = ? FOR UPDATE',
        [link.channelId]
      );
      if (owners.length > 0 && owners[0].minecraft_uuid !== normalizeUuid(minecraftUuid)) {
        throw accountConflict('CHZZK_ALREADY_LINKED');
      }
      await connection.execute(
        'INSERT INTO account_links (minecraft_uuid) VALUES (?) ON DUPLICATE KEY UPDATE minecraft_uuid = VALUES(minecraft_uuid)',
        [normalizeUuid(minecraftUuid)]
      );
      await connection.execute(`
        UPDATE account_links
        SET chzzk_channel_id = ?, chzzk_channel_name = ?, chzzk_linked_at = ?
        WHERE minecraft_uuid = ?
      `, [link.channelId, nullableText(link.channelName), toDatabaseDate(link.linkedAt), normalizeUuid(minecraftUuid)]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') throw accountConflict('CHZZK_ALREADY_LINKED');
      throw error;
    } finally {
      connection.release();
    }
    return this.getChzzkLink(minecraftUuid);
  }

  async getYoutubeLink(minecraftUuid) {
    const [rows] = await this.pool.execute(
      'SELECT minecraft_uuid, youtube_channel_id, youtube_channel_name, youtube_linked_at FROM account_links WHERE minecraft_uuid = ? AND youtube_channel_id IS NOT NULL',
      [normalizeUuid(minecraftUuid)]
    );
    return rows.length === 0 ? null : publicYoutube(rows[0]);
  }

  async setYoutubeLink(minecraftUuid, link) {
    const normalizedUuid = normalizeUuid(minecraftUuid);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [owners] = await connection.execute(
        'SELECT minecraft_uuid FROM account_links WHERE youtube_channel_id = ? FOR UPDATE',
        [link.channelId]
      );
      if (owners.length > 0 && owners[0].minecraft_uuid !== normalizedUuid) {
        throw accountConflict('YOUTUBE_ALREADY_LINKED');
      }
      await connection.execute(
        'INSERT INTO account_links (minecraft_uuid) VALUES (?) ON DUPLICATE KEY UPDATE minecraft_uuid = VALUES(minecraft_uuid)',
        [normalizedUuid]
      );
      await connection.execute(`
        UPDATE account_links
        SET youtube_channel_id = ?, youtube_channel_name = ?, youtube_linked_at = ?
        WHERE minecraft_uuid = ?
      `, [link.channelId, nullableText(link.channelName), toDatabaseDate(link.linkedAt), normalizedUuid]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') throw accountConflict('YOUTUBE_ALREADY_LINKED');
      throw error;
    } finally {
      connection.release();
    }
    return this.getYoutubeLink(normalizedUuid);
  }

  async getDiscordLink(minecraftUuid) {
    const [rows] = await this.pool.execute(
      'SELECT minecraft_uuid, discord_user_id, discord_username, discord_nickname, discord_linked_at FROM account_links WHERE minecraft_uuid = ? AND discord_user_id IS NOT NULL',
      [normalizeUuid(minecraftUuid)]
    );
    return rows.length === 0 ? null : publicDiscord(rows[0]);
  }

  async setDiscordLink(minecraftUuid, link) {
    const normalizedUuid = normalizeUuid(minecraftUuid);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [owners] = await connection.execute(
        'SELECT minecraft_uuid FROM account_links WHERE discord_user_id = ? FOR UPDATE',
        [link.discordUserId]
      );
      if (owners.length > 0 && owners[0].minecraft_uuid !== normalizedUuid) {
        throw accountConflict('DISCORD_ALREADY_LINKED');
      }
      await connection.execute(
        'INSERT INTO account_links (minecraft_uuid) VALUES (?) ON DUPLICATE KEY UPDATE minecraft_uuid = VALUES(minecraft_uuid)',
        [normalizedUuid]
      );
      await connection.execute(`
        UPDATE account_links
        SET discord_user_id = ?, discord_username = ?, discord_nickname = ?, discord_linked_at = ?
        WHERE minecraft_uuid = ?
      `, [link.discordUserId, nullableText(link.discordUsername), nullableText(link.discordNickname), toDatabaseDate(link.linkedAt), normalizedUuid]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') throw accountConflict('DISCORD_ALREADY_LINKED');
      throw error;
    } finally {
      connection.release();
    }
    return this.getDiscordLink(normalizedUuid);
  }

  async deleteDiscordLink(minecraftUuid) {
    await this.pool.execute(`
      UPDATE account_links
      SET discord_user_id = NULL, discord_username = NULL, discord_nickname = NULL, discord_linked_at = NULL
      WHERE minecraft_uuid = ?
    `, [normalizeUuid(minecraftUuid)]);
    await this.deleteEmptyAccount(minecraftUuid);
  }

  async migrateLegacyChzzkLinks(entries) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [completed] = await connection.execute(
        'SELECT migration_key FROM service_migrations WHERE migration_key = ? FOR UPDATE',
        [SCHEMA_VERSION]
      );
      if (completed.length > 0) {
        await connection.commit();
        return { migrated: false, count: 0 };
      }

      let count = 0;
      for (const [minecraftUuid, link] of entries) {
        if (!isUuid(minecraftUuid) || !link || typeof link.channelId !== 'string' || !link.channelId.trim()) continue;
        try {
          const [existingOwners] = await connection.execute(
            'SELECT minecraft_uuid FROM account_links WHERE chzzk_channel_id = ? FOR UPDATE',
            [link.channelId.trim()]
          );
          if (existingOwners.length > 0 && existingOwners[0].minecraft_uuid !== normalizeUuid(minecraftUuid)) continue;
          await connection.execute(
            'INSERT INTO account_links (minecraft_uuid) VALUES (?) ON DUPLICATE KEY UPDATE minecraft_uuid = VALUES(minecraft_uuid)',
            [normalizeUuid(minecraftUuid)]
          );
          await connection.execute(`
            UPDATE account_links
            SET
              chzzk_channel_id = COALESCE(chzzk_channel_id, ?),
              chzzk_channel_name = COALESCE(chzzk_channel_name, ?),
              chzzk_linked_at = COALESCE(chzzk_linked_at, ?)
            WHERE minecraft_uuid = ?
          `, [link.channelId.trim(), nullableText(link.channelName), toDatabaseDate(link.linkedAt), normalizeUuid(minecraftUuid)]);
          count++;
        } catch (error) {
          if (error?.code !== 'ER_DUP_ENTRY') throw error;
        }
      }
      await connection.execute('INSERT INTO service_migrations (migration_key) VALUES (?)', [SCHEMA_VERSION]);
      await connection.commit();
      return { migrated: true, count };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteEmptyAccount(minecraftUuid) {
    await this.pool.execute(
      'DELETE FROM account_links WHERE minecraft_uuid = ? AND discord_user_id IS NULL AND chzzk_channel_id IS NULL AND youtube_channel_id IS NULL',
      [normalizeUuid(minecraftUuid)]
    );
  }

  async close() {
    await this.pool.end();
  }
}

function publicAccount(row) {
  return {
    minecraftUuid: row.minecraft_uuid,
    discord: row.discord_user_id ? publicDiscord(row) : null,
    chzzk: row.chzzk_channel_id ? publicChzzk(row) : null,
    youtube: row.youtube_channel_id ? publicYoutube(row) : null
  };
}

function publicDiscord(row) {
  return {
    minecraftUuid: row.minecraft_uuid,
    discordUserId: row.discord_user_id,
    discordUsername: row.discord_username ?? null,
    discordNickname: row.discord_nickname ?? null,
    linkedAt: isoDate(row.discord_linked_at)
  };
}

function publicChzzk(row) {
  return {
    minecraftUuid: row.minecraft_uuid,
    channelId: row.chzzk_channel_id,
    channelName: row.chzzk_channel_name ?? null,
    linkedAt: isoDate(row.chzzk_linked_at)
  };
}

function publicYoutube(row) {
  return {
    minecraftUuid: row.minecraft_uuid,
    channelId: row.youtube_channel_id,
    channelName: row.youtube_channel_name ?? null,
    linkedAt: isoDate(row.youtube_linked_at)
  };
}

function accountConflict(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeUuid(value) {
  return String(value).toLowerCase();
}

function nullableText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toDatabaseDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isoDate(value) {
  if (!value) return null;
  const normalized = typeof value === 'string' && !/[zZ]|[+-]\d\d:\d\d$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
