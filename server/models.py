"""SQLAlchemy models for LDA filings storage (PostgreSQL)."""
import datetime
import os
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
    display_name = Column(String(500))
    first_seen = Column(DateTime)
    last_seen = Column(DateTime)
    mention_count = Column(Integer, default=0)

    __table_args__ = (
        Index("ix_entities_name_type", "name", "entity_type", unique=True),
    )


class EntityMention(Base):
    __tablename__ = "entity_mentions"

    id = Column(Integer, primary_key=True)
    entity_id = Column(Integer, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False, index=True)
    newsletter_id = Column(Integer, ForeignKey("newsletters.id", ondelete="CASCADE"), nullable=False, index=True)
    paragraph_index = Column(Integer)
    context_text = Column(Text)


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

    __table_args__ = (
        Index("ix_relationships_pair", "entity_a_id", "entity_b_id", unique=True),
    )


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


def get_session(engine):
    Session = sessionmaker(bind=engine)
    return Session()
