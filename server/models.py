"""SQLAlchemy models for LDA filings storage (PostgreSQL)."""
import datetime
import logging
import os

logger = logging.getLogger(__name__)
from sqlalchemy import (
    Column, String, Integer, Float, Text, DateTime, Boolean,
    ForeignKey, Index, create_engine
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

Base = declarative_base()


class Registrant(Base):
    __tablename__ = "registrants"

    id = Column(Integer, primary_key=True)
    senate_id = Column(Integer, unique=True, nullable=False, index=True)
    name = Column(String(500), nullable=False, index=True)
    description = Column(Text)
    address = Column(String(500))
    country = Column(String(200))
    state = Column(String(100))

    filings = relationship("Filing", back_populates="registrant")


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True)
    senate_id = Column(Integer, unique=True, nullable=False, index=True)
    name = Column(String(500), nullable=False, index=True)
    description = Column(Text)
    country = Column(String(200))
    state = Column(String(100))

    filings = relationship("Filing", back_populates="client")


class Filing(Base):
    __tablename__ = "filings"

    id = Column(Integer, primary_key=True)
    filing_uuid = Column(String(36), unique=True, nullable=False, index=True)
    filing_type = Column(String(50), index=True)
    filing_type_display = Column(String(200))
    filing_year = Column(Integer, index=True)
    filing_period = Column(String(50), index=True)
    filing_period_display = Column(String(200))
    filing_date = Column(DateTime, index=True)
    dt_posted = Column(DateTime, index=True)
    added_to_db = Column(DateTime, default=datetime.datetime.utcnow, index=True)
    income = Column(Float)
    expenses = Column(Float)
    expenses_method = Column(String(100))
    expenses_method_display = Column(String(200))
    posted_by_name = Column(String(300))
    url = Column(String(500))

    registrant_id = Column(Integer, ForeignKey("registrants.id"), index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), index=True)

    registrant = relationship("Registrant", back_populates="filings")
    client = relationship("Client", back_populates="filings")
    lobbying_activities = relationship("LobbyingActivity", back_populates="filing", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_filings_year_period", "filing_year", "filing_period"),
    )


class LobbyingActivity(Base):
    __tablename__ = "lobbying_activities"

    id = Column(Integer, primary_key=True)
    filing_id = Column(Integer, ForeignKey("filings.id", ondelete="CASCADE"), nullable=False, index=True)
    general_issue_code = Column(String(10), index=True)
    general_issue_code_display = Column(String(200), index=True)
    description = Column(Text)
    specific_issues = Column(Text)
    government_entities = Column(Text)
    lobbyists = Column(Text)

    filing = relationship("Filing", back_populates="lobbying_activities")


# ---------- Politico Influence Models ----------

class Newsletter(Base):
    __tablename__ = "newsletters"

    id = Column(Integer, primary_key=True)
    url = Column(String(500), unique=True, nullable=False, index=True)
    title = Column(String(500), nullable=False)
    published_date = Column(DateTime, index=True)
    body_text = Column(Text)
    body_html = Column(Text)
    scraped_at = Column(DateTime, default=datetime.datetime.utcnow)

    entities_extracted = Column(Boolean, default=False)


class Entity(Base):
    __tablename__ = "entities"

    id = Column(Integer, primary_key=True)
    name = Column(String(500), nullable=False, index=True)
    entity_type = Column(String(50), index=True)
    is_consultant = Column(Boolean, default=False, index=True)
    is_client = Column(Boolean, default=False, index=True)
    display_name = Column(String(500))
    first_seen = Column(DateTime)
    last_seen = Column(DateTime)
    mention_count = Column(Integer, default=0)
    user_override = Column(Boolean, default=False)
    registrant_id = Column(Integer, ForeignKey("registrants.id"), nullable=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    is_lobbyist = Column(Boolean, default=False, index=True)
    lobbyist_senate_id = Column(Integer, nullable=True)
    lda_match_method = Column(String(20), nullable=True)

    __table_args__ = (
        Index("ix_entities_name", "name", unique=True),
    )


class EntityMention(Base):
    __tablename__ = "entity_mentions"

    id = Column(Integer, primary_key=True)
    entity_id = Column(Integer, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False, index=True)
    newsletter_id = Column(Integer, ForeignKey("newsletters.id", ondelete="CASCADE"), nullable=False, index=True)
    paragraph_index = Column(Integer)
    context_text = Column(Text)
    section_heading = Column(String(500))


class Relationship(Base):
    __tablename__ = "relationships"

    id = Column(Integer, primary_key=True)
    entity_a_id = Column(Integer, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False, index=True)
    entity_b_id = Column(Integer, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False, index=True)
    relationship_type = Column(String(50), default="co_mention")
    weight = Column(Integer, default=1)
    first_seen = Column(DateTime)
    last_seen = Column(DateTime)
    context_snippets = Column(Text)
    filing_id = Column(Integer, ForeignKey("filings.id"), nullable=True, index=True)
    match_confidence = Column(String(20), nullable=True)

    __table_args__ = (
        Index("ix_relationships_pair", "entity_a_id", "entity_b_id", unique=True),
    )


class ChatConversation(Base):
    __tablename__ = "chat_conversations"

    id = Column(Integer, primary_key=True)
    title = Column(String(500), nullable=False, default="New conversation")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=True)

    messages = relationship("ChatMessage", back_populates="conversation", order_by="ChatMessage.created_at")


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id"), nullable=False, index=True)
    role = Column(String(20), nullable=False)  # 'user' or 'assistant'
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    conversation = relationship("ChatConversation", back_populates="messages")


def get_engine(db_url=None):
    if db_url is None:
        db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL environment variable is not set")
    engine = create_engine(db_url, echo=False, pool_pre_ping=True)
    return engine


def init_db(db_url=None):
    engine = get_engine(db_url)
    Base.metadata.create_all(engine, checkfirst=True)
    return engine


def run_migrations(engine):
    """Run schema migrations. Returns a set of migration names that were applied."""
    from sqlalchemy import inspect, text as sa_text
    inspector = inspect(engine)
    applied = set()

    table_names = set(inspector.get_table_names())

    if "entities" in table_names:
        ent_cols = {c["name"] for c in inspector.get_columns("entities")}

        # Migration: replace single 'role' column with is_consultant/is_client booleans
        if "role" in ent_cols:
            with engine.begin() as conn:
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN is_consultant BOOLEAN DEFAULT FALSE"))
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN is_client BOOLEAN DEFAULT FALSE"))
                conn.execute(sa_text("UPDATE entities SET is_consultant = TRUE WHERE role = 'consultant'"))
                conn.execute(sa_text("UPDATE entities SET is_client = TRUE WHERE role = 'client'"))
                conn.execute(sa_text("ALTER TABLE entities DROP COLUMN role"))
                conn.execute(sa_text("CREATE INDEX ix_entities_is_consultant ON entities (is_consultant)"))
                conn.execute(sa_text("CREATE INDEX ix_entities_is_client ON entities (is_client)"))
            ent_cols.discard("role")
            ent_cols.update({"is_consultant", "is_client"})
            applied.add("role_to_booleans")
        elif "is_consultant" not in ent_cols:
            with engine.begin() as conn:
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN is_consultant BOOLEAN DEFAULT FALSE"))
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN is_client BOOLEAN DEFAULT FALSE"))
                conn.execute(sa_text("CREATE INDEX ix_entities_is_consultant ON entities (is_consultant)"))
                conn.execute(sa_text("CREATE INDEX ix_entities_is_client ON entities (is_client)"))
            ent_cols.update({"is_consultant", "is_client"})
            applied.add("role_to_booleans")

        # Migration: add registrant_id/client_id for LDA linking
        if "registrant_id" not in ent_cols:
            with engine.begin() as conn:
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN registrant_id INTEGER REFERENCES registrants(id)"))
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN client_id INTEGER REFERENCES clients(id)"))
                conn.execute(sa_text("CREATE INDEX ix_entities_registrant_id ON entities (registrant_id)"))
                conn.execute(sa_text("CREATE INDEX ix_entities_client_id ON entities (client_id)"))
            applied.add("lda_fk_columns")

        # Migration: add is_lobbyist/lobbyist_senate_id
        if "is_lobbyist" not in ent_cols:
            with engine.begin() as conn:
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN is_lobbyist BOOLEAN DEFAULT FALSE"))
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN lobbyist_senate_id INTEGER"))
                conn.execute(sa_text("CREATE INDEX ix_entities_is_lobbyist ON entities (is_lobbyist)"))
            applied.add("lobbyist_columns")

        # Migration: add lda_match_method
        if "lda_match_method" not in ent_cols:
            with engine.begin() as conn:
                conn.execute(sa_text("ALTER TABLE entities ADD COLUMN lda_match_method VARCHAR(20)"))
            applied.add("lda_match_method")

    if "relationships" in table_names:
        rel_cols = {c["name"] for c in inspector.get_columns("relationships")}

        # Migration: add filing_id
        if "filing_id" not in rel_cols:
            with engine.begin() as conn:
                conn.execute(sa_text("ALTER TABLE relationships ADD COLUMN filing_id INTEGER REFERENCES filings(id)"))
                conn.execute(sa_text("CREATE INDEX ix_relationships_filing_id ON relationships (filing_id)"))
            applied.add("relationship_filing_id")

        # Migration: add match_confidence
        if "match_confidence" not in rel_cols:
            with engine.begin() as conn:
                conn.execute(sa_text("ALTER TABLE relationships ADD COLUMN match_confidence VARCHAR(20)"))
            applied.add("relationship_match_confidence")

    # Migration: create chat tables
    if "chat_conversations" not in table_names:
        ChatConversation.__table__.create(engine, checkfirst=True)
        ChatMessage.__table__.create(engine, checkfirst=True)
        applied.add("chat_tables")

    # One-time migration: delete 2025 filings
    if "filings" in table_names:
        with engine.begin() as conn:
            count = conn.execute(sa_text("SELECT COUNT(*) FROM filings WHERE filing_year = 2025")).scalar()
            if count and count > 0:
                conn.execute(sa_text("DELETE FROM lobbying_activities WHERE filing_id IN (SELECT id FROM filings WHERE filing_year = 2025)"))
                conn.execute(sa_text("DELETE FROM filings WHERE filing_year = 2025"))
                logger.info(f"Deleted {count} filings from 2025")
                applied.add("delete_2025_filings")

    return applied


def get_session(engine):
    Session = sessionmaker(bind=engine)
    return Session()
